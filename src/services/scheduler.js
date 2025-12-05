import cron from 'node-cron';
import { getAllUsers } from '../db/userService.js';
import { queueDailyTask } from './QueueService.js'; // [UPDATED] Import queue function
import logger from '../utils/logger.js';

// Run at 8 PM WAT (Lagos)
const SCHEDULE_TIME = '0 19 * * *'; 

export function startDailyScheduler() {
    logger.info(`Scheduler initialized. Will run daily at 19:00 UTC (8 PM WAT).`);
    
    cron.schedule(SCHEDULE_TIME, async () => {
        logger.info('⏰ Scheduler triggered: Queuing Daily Closing Ritual...');
        
        try {
            const users = await getAllUsers();
            logger.info(`Found ${users.length} active users. Adding to queue...`);

            // [UPDATED] Push to Queue instead of processing immediately
            for (const user of users) {
                await queueDailyTask(user._id);
            }
            
            logger.info(`Successfully queued ${users.length} daily tasks.`);
        } catch (e) {
            logger.error('Error in daily scheduler loop:', e);
        }
    });
}
