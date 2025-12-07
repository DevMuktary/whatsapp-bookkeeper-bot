import express from 'express';
import crypto from 'crypto'; // [NEW] For signature verification
import IORedis from 'ioredis'; 
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleMessage, handleFlowResponse } from '../handlers/messageHandler.js';
import { handleInteractiveMessage } from '../handlers/interactiveHandler.js';
import { sendTextMessage } from '../api/whatsappService.js';

const router = express.Router();

// --- REDIS RATE LIMIT CONFIGURATION ---
const RATE_LIMIT = 10;           // Max messages allowed
const RATE_WINDOW = 60;          // Per 60 seconds
const redis = new IORedis(config.redis.url, config.redis.options); 

redis.on('error', (err) => logger.error('Redis Rate Limit Error:', err));

async function isRateLimited(whatsappId) {
    const key = `rate_limit:${whatsappId}`;
    
    try {
        const currentCount = await redis.incr(key);
        if (currentCount === 1) {
            await redis.expire(key, RATE_WINDOW);
        }

        if (currentCount > RATE_LIMIT) {
            const warningKey = `rate_warning:${whatsappId}`;
            const alreadyWarned = await redis.get(warningKey);
            
            if (!alreadyWarned) {
                await sendTextMessage(whatsappId, "⛔ Whoa, slow down! You are sending too many messages. Please wait a minute.");
                await redis.set(warningKey, 'true', 'EX', RATE_WINDOW); 
            }
            return true; 
        }
        return false;
    } catch (error) {
        logger.error("Rate limit check failed:", error);
        return false; // Fail open if Redis is down
    }
}

// [NEW] Helper to Verify Signature
function verifySignature(req) {
    // 1. Get the signature from headers
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;

    // 2. Create the hash using your App Secret
    const hmac = crypto.createHmac('sha256', config.whatsapp.appSecret);
    
    // 3. Update with the raw body buffer (enabled in index.js)
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    // 4. Compare
    return signature === digest;
}

// Route for WhatsApp webhook verification (GET)
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

// Route for receiving messages and events (POST)
router.post('/', async (req, res) => {
  // 1. [NEW] SECURITY CHECK
  if (!verifySignature(req)) {
      logger.warn('⚠️ Invalid WhatsApp Signature! Request Dropped.');
      return res.sendStatus(401); // Unauthorized
  }

  res.sendStatus(200);

  const body = req.body;

  try {
    if (body.object === 'whatsapp_business_account') {
      const changes = body.entry?.[0]?.changes?.[0]?.value;
      
      if (changes?.messages?.[0]) {
          const message = changes.messages[0];
          const whatsappId = message.from;

          // 2. CHECK REDIS RATE LIMIT
          if (await isRateLimited(whatsappId)) {
              logger.warn(`Rate limit hit for ${whatsappId}. Dropping message.`);
              return; 
          }
          
          // 3. ROUTE MESSAGE
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
