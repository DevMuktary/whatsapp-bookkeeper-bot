import express from 'express';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleMessage } from '../handlers/messageHandler.js';

const router = express.Router();

// Route for WhatsApp webhook verification (no changes)
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
  
  // Immediately send a 200 OK response to Meta.
  res.sendStatus(200);

  // Asynchronously process the message
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === 'text') { // Only process text messages for now
      handleMessage(message);
    }
  } else {
    logger.warn('Received a non-whatsapp_business_account payload');
  }
});

export default router;
