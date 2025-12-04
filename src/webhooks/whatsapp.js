import express from 'express';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleMessage } from '../handlers/messageHandler.js';
import { handleInteractiveMessage } from '../handlers/interactiveHandler.js';
import { sendTextMessage } from '../api/whatsappService.js'; // [NEW] Needed to send the warning

const router = express.Router();

// --- RATE LIMIT CONFIGURATION ---
const RATE_LIMIT = 10;           // Max messages
const RATE_WINDOW = 60 * 1000;   // Per 1 minute (in milliseconds)
const userRateLimit = new Map(); // Simple in-memory store

/**
 * Checks if a user has exceeded the rate limit.
 * Returns TRUE if they should be blocked.
 */
async function isRateLimited(whatsappId) {
    const now = Date.now();
    
    let record = userRateLimit.get(whatsappId);

    // If no record exists, or the time window has passed, start a new window
    if (!record || (now - record.startTime > RATE_WINDOW)) {
        record = { count: 0, startTime: now, warningSent: false };
        userRateLimit.set(whatsappId, record);
    }

    record.count++;

    // If they exceeded the limit
    if (record.count > RATE_LIMIT) {
        // Only warn them ONCE per window (to avoid spamming the warning itself)
        if (!record.warningSent) {
            await sendTextMessage(whatsappId, "⛔ Whoa, slow down! You are sending too many messages. Please wait a minute.");
            record.warningSent = true;
        }
        return true; // BLOCK this message
    }

    return false; // ALLOW this message
}

// Route for WhatsApp webhook verification
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === config.whatsapp.verifyToken) {
    logger.info('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    logger.warn('Webhook verification failed.');
    res.sendStatus(403);
  }
});

// Route for receiving messages and events
router.post('/', async (req, res) => {
  // Always return 200 OK immediately to WhatsApp so they don't keep retrying
  res.sendStatus(200);

  const body = req.body;

  try {
    if (body.object === 'whatsapp_business_account') {
      const changes = body.entry?.[0]?.changes?.[0]?.value;
      
      if (changes?.messages?.[0]) {
          const message = changes.messages[0];
          const whatsappId = message.from;

          // [NEW] CHECK RATE LIMIT BEFORE PROCESSING
          if (await isRateLimited(whatsappId)) {
              logger.warn(`Rate limit hit for ${whatsappId}. Dropping message.`);
              return; // Stop execution here
          }
          
          // If safe, proceed to handlers
          if (message.type === 'text' || message.type === 'image' || message.type === 'audio') {
              await handleMessage(message);
          } 
          else if (message.type === 'interactive') {
              await handleInteractiveMessage(message);
          }
      }
    }
  } catch (error) {
      logger.error("Error processing webhook:", error);
  }
});

export default router;
