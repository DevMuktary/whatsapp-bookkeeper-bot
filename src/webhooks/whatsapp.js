import express from 'express';
import crypto from 'crypto'; 
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleMessage, handleFlowResponse } from '../handlers/messageHandler.js';
import { handleInteractiveMessage } from '../handlers/interactiveHandler.js';
import { sendTextMessage } from '../api/whatsappService.js';
import redis from '../db/redisClient.js'; // [FIX] Use Singleton

const router = express.Router();

const RATE_LIMIT = 10;           
const RATE_WINDOW = 60;          

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
        return false; 
    }
}

function verifySignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;
    const hmac = crypto.createHmac('sha256', config.whatsapp.appSecret);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
    return signature === digest;
}

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

router.post('/', async (req, res) => {
  if (!verifySignature(req)) {
      logger.warn('⚠️ Invalid WhatsApp Signature! Request Dropped.');
      return res.sendStatus(401); 
  }
  res.sendStatus(200);
  const body = req.body;
  try {
    if (body.object === 'whatsapp_business_account') {
      const changes = body.entry?.[0]?.changes?.[0]?.value;
      if (changes?.messages?.[0]) {
          const message = changes.messages[0];
          const whatsappId = message.from;
          if (await isRateLimited(whatsappId)) {
              logger.warn(`Rate limit hit for ${whatsappId}. Dropping message.`);
              return; 
          }
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
