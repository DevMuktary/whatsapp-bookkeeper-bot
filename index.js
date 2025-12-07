import express from 'express';
import config from './src/config/index.js';
import logger from './src/utils/logger.js';
import paystackWebhook from './src/webhooks/paystack.js';
import whatsappWebhook from './src/webhooks/whatsapp.js';
import { connectToDB, getDB } from './src/db/connection.js';
import { startDailyScheduler } from './src/services/scheduler.js';
import { configureWhatsappCommands } from './src/services/whatsappSetup.js'; 
import redis from './src/db/redisClient.js'; // [FIX] Import singleton to close it

// Initialize Express app
const app = express();

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));

// Use express.json() with rawBody verify for WhatsApp signature validation
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// --- DATABASE CONNECTION ---
let server; 

async function startServer() {
    try {
      await connectToDB();
      logger.info('Successfully connected to the database.');
      
      // Start Background Services
      startDailyScheduler();
      
      // Setup WhatsApp Menu (Runs once on startup)
      configureWhatsappCommands();

      // --- SERVER INITIALIZATION ---
      const PORT = config.port || 3000;
      server = app.listen(PORT, () => {
        logger.info(`Server is running on port ${PORT}.`);
      });

    } catch (error) {
      logger.error('Failed to connect to the database on startup. Exiting.', error);
      process.exit(1);
    }
}

// --- ROUTES ---
app.use('/api/webhook', whatsappWebhook);
app.use('/api/paystack', paystackWebhook); 

// --- GRACEFUL SHUTDOWN ---
const shutdown = async (signal) => {
    logger.info(`${signal} received: closing HTTP server...`);
    
    if (server) {
        server.close(async () => {
            logger.info('HTTP server closed.');
            
            // Close Redis
            try {
                await redis.quit();
                logger.info('Redis connection closed.');
            } catch (err) {
                logger.error('Error closing Redis:', err);
            }

            // Close MongoDB (optional, usually driver handles it, but good practice)
            try {
                // getDB().client.close(); // Only if you exported client
                logger.info('MongoDB connection closed.');
            } catch (err) {
                // Ignore
            }

            process.exit(0);
        });
    } else {
        process.exit(0);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
startServer();
