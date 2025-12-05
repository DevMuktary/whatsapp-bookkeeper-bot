import express from 'express';
import config from './src/config/index.js';
import logger from './src/utils/logger.js';
import whatsappWebhook from './src/webhooks/whatsapp.js';
import { connectToDB } from './src/db/connection.js';
import { startDailyScheduler } from './src/services/scheduler.js';
import { configureWhatsappCommands } from './src/services/whatsappSetup.js'; // [NEW]

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
try {
  await connectToDB();
  logger.info('Successfully connected to the database.');
  
  // Start Background Services
  startDailyScheduler();
  
  // [NEW] Setup WhatsApp Menu (Runs once on startup)
  configureWhatsappCommands();

} catch (error) {
  logger.error('Failed to connect to the database on startup. Exiting.', error);
  process.exit(1);
}

// --- ROUTES ---
app.use('/api/webhook', whatsappWebhook);

// --- SERVER INITIALIZATION ---
const PORT = config.port || 3000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}.`);
});
