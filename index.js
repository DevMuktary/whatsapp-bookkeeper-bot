import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './src/config/index.js';
import logger from './src/utils/logger.js';
import whatsappWebhook from './src/webhooks/whatsapp.js';
import webRoutes from './src/api/webRoutes.js';
import { connectToDB } from './src/db/connection.js';

// Setup for static file path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();

// --- MIDDLEWARE ---
app.use(cors()); // Allow browser requests for the dashboard
app.use(express.urlencoded({ extended: true }));

// Use express.json() with rawBody verify for WhatsApp signature validation
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// --- SERVE FRONTEND ---
// Ensure this path is correct. If your index.js is in the root, 'public' should be in the root.
app.use(express.static(path.resolve(__dirname, 'public')));

// --- DATABASE CONNECTION ---
try {
  await connectToDB();
  logger.info('Successfully connected to the database.');
} catch (error) {
  logger.error('Failed to connect to the database on startup. Exiting.', error);
  process.exit(1);
}

// --- ROUTES ---

// 1. Web Dashboard API
app.use('/api', webRoutes);

// 2. WhatsApp Webhook
app.use('/api/webhook', whatsappWebhook);

// --- SERVER INITIALIZATION ---
const PORT = config.port || 3000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}.`);
  logger.info(`Dashboard accessible at http://localhost:${PORT}/login.html`);
});

