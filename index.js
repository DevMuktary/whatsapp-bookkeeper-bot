import express from 'express';
import cors from 'cors';
import config from './src/config/index.js';
import { connectToDB } from './src/db/connection.js';
import whatsappRouter from './src/webhooks/whatsapp.js';
import logger from './src/utils/logger.js';

const app = express();

// Middleware to parse JSON bodies (Required for WhatsApp Webhooks)
app.use(express.json());
app.use(cors());

// Health check route (useful for checking if the server is alive)
app.get('/', (req, res) => {
  res.send('Fynax Bookkeeper Bot is running! 🚀');
});

// Mount the WhatsApp webhook router
// NOTE: Make sure your Meta App Dashboard Callback URL matches this path.
// e.g., https://your-domain.com/webhook
app.use('/webhook', whatsappRouter);

// Start the Server
async function startServer() {
  try {
    // 1. Connect to Database
    await connectToDB();

    // 2. Start Listening
    app.listen(config.port, () => {
      logger.info(`Server is running on port ${config.port}`);
    });

  } catch (error) {
    logger.error('Failed to start the server:', error);
    process.exit(1);
  }
}

startServer();
