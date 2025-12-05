import cron from 'node-cron';
import { getAllUsers, checkSubscriptionAccess } from '../db/userService.js';
import { queueDailyTask } from './QueueService.js'; 
import { sendTextMessage, sendPaymentOptions } from '../api/whatsappService.js'; // [NEW IMPORT]
import logger from '../utils/logger.js';

// Run at 8 PM WAT (Lagos)
const SCHEDULE_TIME = '0 19 * * *'; 

export function startDailyScheduler() {
    logger.info(`Scheduler initialized. Will run daily at 19:00 UTC (8 PM WAT).`);
    
    cron.schedule(SCHEDULE_TIME, async () => {
        logger.info('⏰ Scheduler triggered: Queuing Daily Tasks...');
        
        try {
            const users = await getAllUsers();
            logger.info(`Found ${users.length} active users.`);

            for (const user of users) {
                // [NEW] SUBSCRIPTION CHECKS (Run instantly before queueing heavy tasks)
                await processSubscriptionReminder(user);

                // Queue heavy report tasks
                await queueDailyTask(user._id);
            }
            
        } catch (e) {
            logger.error('Error in daily scheduler loop:', e);
        }
    });
}

async function processSubscriptionReminder(user) {
    const access = checkSubscriptionAccess(user);
    
    // Only remind on specific days to avoid being annoying
    if (access.daysLeft === 4) {
        await sendTextMessage(user.whatsappId, 
            `🔔 **Reminder:** Your Fynax plan expires in 4 days.\n\nRenew now to avoid service interruption.`
        );
        await sendPaymentOptions(user.whatsappId);
    } 
    else if (access.daysLeft === 1) {
        await sendTextMessage(user.whatsappId, 
            `⚠️ **Urgent:** Your service expires TOMORROW.\n\nOnce expired, you will lose access to logging sales and reports. Renew now.`
        );
        await sendPaymentOptions(user.whatsappId);
    }
}
