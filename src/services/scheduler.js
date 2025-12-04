import cron from 'node-cron';
import { getAllUsers } from '../db/userService.js';
import { getTransactionsByDateRange, getDueTransactions } from '../db/transactionService.js';
import { findCustomerById } from '../db/customerService.js';
import { sendTextMessage, sendInteractiveButtons } from '../api/whatsappService.js';
import logger from '../utils/logger.js';

// Run at 8 PM WAT (Lagos)
const SCHEDULE_TIME = '0 19 * * *'; 

export function startDailyScheduler() {
    logger.info(`Scheduler initialized. Will run daily at 19:00 UTC (8 PM WAT).`);
    
    cron.schedule(SCHEDULE_TIME, async () => {
        logger.info('⏰ Running Daily Closing Ritual & Debt Check...');
        const users = await getAllUsers();
        logger.info(`Found ${users.length} active users to process.`);

        for (const user of users) {
            try {
                await new Promise(r => setTimeout(r, Math.random() * 5000));
                
                // 1. Send Profit Summary
                await processDailyUserSummary(user);
                
                // 2. [NEW] Check for Debt Collection
                await processDueDebts(user);

            } catch (e) {
                logger.error(`Error processing scheduler for ${user.whatsappId}:`, e);
            }
        }
    });
}

async function processDailyUserSummary(user) {
    const today = new Date();
    const startOfDay = new Date(today); 
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    const sales = await getTransactionsByDateRange(user._id, 'SALE', startOfDay, endOfDay);
    const expenses = await getTransactionsByDateRange(user._id, 'EXPENSE', startOfDay, endOfDay);

    const totalSales = sales.reduce((acc, curr) => acc + curr.amount, 0);
    const totalExpenses = expenses.reduce((acc, curr) => acc + curr.amount, 0);
    const profit = totalSales - totalExpenses;

    if (totalSales === 0 && totalExpenses === 0) {
        const businessName = user.businessName || 'there';
        await sendTextMessage(
            user.whatsappId, 
            `👋 Hey ${businessName}, did you make any sales today that you forgot to log?\n\nReply with something like 'Sold 5 rice' now to keep your books balanced!`
        );
    } else {
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

// [NEW] "The Debt Collector" Logic
async function processDueDebts(user) {
    const today = new Date();
    const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

    // Find credit sales explicitly due TODAY
    const dueTxns = await getDueTransactions(user._id, startOfDay, endOfDay);

    for (const tx of dueTxns) {
        if (!tx.linkedCustomerId) continue;

        // Verify they still owe money
        const customer = await findCustomerById(tx.linkedCustomerId);
        if (customer && customer.balanceOwed > 0) {
            const currency = user.currency || '';
            const amount = tx.amount.toLocaleString();
            
            await sendTextMessage(user.whatsappId, 
                `🔔 *Payment Due Today:*\n\n` +
                `**${customer.customerName}** owes you **${currency} ${amount}** from a sale on ${new Date(tx.date).toLocaleDateString()}.\n\n` +
                `Their total outstanding balance is ${currency} ${customer.balanceOwed.toLocaleString()}.`
            );

            // Optional: Ask to generate reminder
            // (In a fuller version, you'd send an interactive button here)
        }
    }
}
