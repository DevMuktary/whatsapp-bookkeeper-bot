import express from 'express';
import IORedis from 'ioredis'; // [NEW] Import Redis
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleMessage, handleFlowResponse } from '../handlers/messageHandler.js';
import { handleInteractiveMessage } from '../handlers/interactiveHandler.js';
import { sendTextMessage } from '../api/whatsappService.js';

const router = express.Router();

// --- [UPDATED] REDIS RATE LIMIT CONFIGURATION ---
const RATE_LIMIT = 10;           // Max messages allowed
const RATE_WINDOW = 60;          // Per 60 seconds
const redis = new IORedis(config.redis.url, config.redis.options); // Connect to Redis

redis.on('error', (err) => logger.error('Redis Rate Limit Error:', err));

async function isRateLimited(whatsappId) {
    const key = `rate_limit:${whatsappId}`;
    
    try {
        // Increment the counter
        const currentCount = await redis.incr(key);
        
        // If it's the first message, set the expiry
        if (currentCount === 1) {
            await redis.expire(key, RATE_WINDOW);
        }

        if (currentCount > RATE_LIMIT) {
            // Check if we already warned them to prevent spamming the warning
            const warningKey = `rate_warning:${whatsappId}`;
            const alreadyWarned = await redis.get(warningKey);
            
            if (!alreadyWarned) {
                await sendTextMessage(whatsappId, "⛔ Whoa, slow down! You are sending too many messages. Please wait a minute.");
                await redis.set(warningKey, 'true', 'EX', RATE_WINDOW); // Set warning cooldown
            }
            return true; 
        }
        return false;
    } catch (error) {
        logger.error("Rate limit check failed:", error);
        return false; // Fail open (allow message) if Redis is down
    }
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

          // 1. [UPDATED] CHECK REDIS RATE LIMIT
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
