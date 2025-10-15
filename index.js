import express from 'express';
import config from './src/config/index.js';
import logger from './src/utils/logger.js';
import whatsappWebhook from './src/webhooks/whatsapp.js';
import { connectToDB } from './src/db/connection.js';

// Initialize Express app
const app = express();

// Use express.json() middleware to parse JSON bodies.
// The `verify` option is crucial for WhatsApp webhook signature validation.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Connect to the database on startup
try {
  await connectToDB();
  logger.info('Successfully connected to the database.');
} catch (error) {
  logger.error('Failed to connect to the database on startup. Exiting.', error);
  process.exit(1); // Exit if the database connection fails
}

// --- Webhook Routes ---
app.use('/api/webhook', whatsappWebhook);

// --- Server Initialization ---
const PORT = config.port || 3000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}. Listening for webhooks...`);
});

