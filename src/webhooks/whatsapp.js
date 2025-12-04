import express from 'express';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleMessage, handleFlowResponse } from '../handlers/messageHandler.js'; // [UPDATED] Import handleFlowResponse
import { handleInteractiveMessage } from '../handlers/interactiveHandler.js';
import { sendTextMessage } from '../api/whatsappService.js';

const router = express.Router();

// --- RATE LIMIT CONFIGURATION ---
const RATE_LIMIT = 10;           // Max messages allowed
const RATE_WINDOW = 60 * 1000;   // Per 1 minute (in milliseconds)
const userRateLimit = new Map(); // Simple in-memory store

async function isRateLimited(whatsappId) {
    const now = Date.now();
    let record = userRateLimit.get(whatsappId);

    if (!record || (now - record.startTime > RATE_WINDOW)) {
        record = { count: 0, startTime: now, warningSent: false };
        userRateLimit.set(whatsappId, record);
    }

    record.count++;

    if (record.count > RATE_LIMIT) {
        if (!record.warningSent) {
            await sendTextMessage(whatsappId, "⛔ Whoa, slow down! You are sending too many messages. Please wait a minute.");
            record.warningSent = true;
        }
        return true; 
    }

    return false; 
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
  res.sendStatus(200);

  const body = req.body;

  try {
    if (body.object === 'whatsapp_business_account') {
      const changes = body.entry?.[0]?.changes?.[0]?.value;
      
      if (changes?.messages?.[0]) {
          const message = changes.messages[0];
          const whatsappId = message.from;

          // 1. CHECK RATE LIMIT
          if (await isRateLimited(whatsappId)) {
              logger.warn(`Rate limit hit for ${whatsappId}. Dropping message.`);
              return; 
          }
          
          // 2. ROUTE MESSAGE
          if (['text', 'image', 'audio', 'document'].includes(message.type)) {
              await handleMessage(message);
          } 
          else if (message.type === 'interactive') {
              const interactive = message.interactive;
              // [NEW] Check for Flow Response
              if (interactive.type === 'nfm_reply') {
                  await handleFlowResponse(message);
              } else {
                  await handleInteractiveMessage(message);
              }
          }
      }
    }
  } catch (error) {
      logger.error("Error processing webhook:", error);
  }
});

export default router;
