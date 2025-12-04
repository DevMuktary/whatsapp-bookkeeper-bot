import cron from 'node-cron';
import { getAllUsers } from '../db/userService.js';
import { getTransactionsByDateRange } from '../db/transactionService.js';
import { sendTextMessage } from '../api/whatsappService.js';
import logger from '../utils/logger.js';

// --- CONFIGURATION ---
// 19:00 UTC is 20:00 (8 PM) West Africa Time (Lagos)
// Cron Expression: "Minute Hour * * *"
const SCHEDULE_TIME = '0 19 * * *'; 

export function startDailyScheduler() {
    logger.info(`Scheduler initialized. Will run daily at 19:00 UTC (8 PM WAT).`);
    
    cron.schedule(SCHEDULE_TIME, async () => {
        logger.info('⏰ Running Daily Closing Ritual...');
        const users = await getAllUsers();
        logger.info(`Found ${users.length} active users to process.`);

        for (const user of users) {
            try {
                // Add a small random delay (0-10s) to prevent spamming WhatsApp API all at once
                await new Promise(r => setTimeout(r, Math.random() * 10000));
                await processDailyUserSummary(user);
            } catch (e) {
                logger.error(`Error processing summary for ${user.whatsappId}:`, e);
            }
        }
    });
}

async function processDailyUserSummary(user) {
    // 1. Define "Today" (User's local time would be ideal, but server time is consistent)
    const today = new Date();
    const startOfDay = new Date(today); 
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    // 2. Fetch Data
    const sales = await getTransactionsByDateRange(user._id, 'SALE', startOfDay, endOfDay);
    const expenses = await getTransactionsByDateRange(user._id, 'EXPENSE', startOfDay, endOfDay);

    // 3. Calculate Totals
    const totalSales = sales.reduce((acc, curr) => acc + curr.amount, 0);
    const totalExpenses = expenses.reduce((acc, curr) => acc + curr.amount, 0);
    const profit = totalSales - totalExpenses;

    // 4. Send Smart Message
    if (totalSales === 0 && totalExpenses === 0) {
        // Scenario B: Silent User (Nudge)
        const businessName = user.businessName || 'there';
        await sendTextMessage(
            user.whatsappId, 
            `👋 Hey ${businessName}, did you make any sales today that you forgot to log?\n\nReply with something like 'Sold 5 rice' now to keep your books balanced!`
        );
    } else {
        // Scenario A: Active User (Summary)
        const currency = user.currency || '';
        const profitEmoji = profit >= 0 ? '📈' : '📉';
        
        const msg = `📉 *Day End Summary* (${today.toLocaleDateString()}):\n\n` +
                    `• Sales: ${currency} ${totalSales.toLocaleString()}\n` +
                    `• Expenses: ${currency} ${totalExpenses.toLocaleString()}\n` +
                    `-------------------\n` +
                    `• *Net Profit: ${currency} ${profit.toLocaleString()}* ${profitEmoji}\n\n` +
                    `Great job today! Rest well. 😴`;
        
        await sendTextMessage(user.whatsappId, msg);
    }
}
