import express from 'express';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleMessage } from '../handlers/messageHandler.js';
import { handleInteractiveMessage } from '../handlers/interactiveHandler.js';

const router = express.Router();

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

// Route for receiving messages and events from WhatsApp
router.post('/', (req, res) => {
  const body = req.body;
  
  res.sendStatus(200);

  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      if (message.type === 'text') {
        handleMessage(message);
      } else if (message.type === 'interactive' && (message.interactive.type === 'button_reply' || message.interactive.type === 'list_reply')) {
        handleInteractiveMessage(message);
      }
    }
  } else {
    logger.warn('Received a non-whatsapp_business_account payload');
  }
});

export default router;
