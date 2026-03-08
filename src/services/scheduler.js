import cron from 'node-cron';
import { getAllUsers, checkSubscriptionAccess } from '../db/userService.js';
import { queueDailyTask } from './QueueService.js'; 
import { sendTextMessage, sendPaymentOptions } from '../api/whatsappService.js';
import { getCustomersWithBalance } from '../db/customerService.js';
import logger from '../utils/logger.js';

// Run daily tasks at 8 PM WAT (Lagos)
const SCHEDULE_TIME = '0 19 * * *'; 

// [FIX] Run every 5 days at 9 AM WAT
const DEBTOR_REMINDER_TIME = '0 9 */5 * *';

export function startDailyScheduler() {
    logger.info(`Scheduler initialized. Will run daily at 19:00 UTC (8 PM WAT).`);
    
    cron.schedule(SCHEDULE_TIME, async () => {
        logger.info('⏰ Scheduler triggered: Queuing Daily Tasks...');
        
        try {
            const users = await getAllUsers();
            logger.info(`Found ${users.length} active users.`);

            for (const user of users) {
                // SUBSCRIPTION CHECKS (Run instantly before queueing heavy tasks)
                await processSubscriptionReminder(user);

                // Queue heavy report tasks
                await queueDailyTask(user._id);
            }
            
        } catch (e) {
            logger.error('Error in daily scheduler loop:', e);
        }
    });

    // [FIX] Added the 5-day reminder scheduler
    logger.info(`Debtor Reminder Scheduler initialized. Will run every 5 days at 9:00 UTC.`);
    
    cron.schedule(DEBTOR_REMINDER_TIME, async () => {
        logger.info('⏰ Debtor Reminder Scheduler triggered...');
        try {
            const users = await getAllUsers();
            
            for (const user of users) {
                // Don't send reminders if their subscription is expired
                const access = checkSubscriptionAccess(user);
                if (!access.allowed) continue; 

                const debtors = await getCustomersWithBalance(user._id);
                if (debtors.length > 0) {
                    const list = debtors.map(c => `• *${c.customerName}*: ${user.currency || '₦'} ${c.balanceOwed.toLocaleString()}`).join('\n');
                    const message = `🔔 *Debtor Reminder*\n\nHere is the list of people who currently owe you money:\n\n${list}\n\n_You receive this reminder every 5 days._`;
                    
                    await sendTextMessage(user.whatsappId, message);
                }
            }
        } catch (error) {
            logger.error('Error in debtor reminder loop:', error);
        }
    });
}

async function processSubscriptionReminder(user) {
    const access = checkSubscriptionAccess(user);
    
    // Only remind on specific days to avoid being annoying
    if (access.daysLeft === 4) {
        await sendTextMessage(user.whatsappId, 
            `🔔 *Reminder:* Your Fynax plan expires in 4 days.\n\nRenew now to avoid service interruption.`
        );
        await sendPaymentOptions(user.whatsappId);
    } 
    else if (access.daysLeft === 1) {
        await sendTextMessage(user.whatsappId, 
            `⚠️ *Urgent:* Your service expires TOMORROW.\n\nOnce expired, you will lose access to logging sales and reports. Renew now.`
        );
        await sendPaymentOptions(user.whatsappId);
    }
}
