import express from 'express';
import config from '../config/index.js';
import logger from '../utils/logger.js';
// TODO: We will import the message handler here in a future phase.
// import { handleMessage } from '../handlers/messageHandler.js';

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

  // For now, we will just log the incoming payload to confirm it's working.
  logger.info('Received WhatsApp payload:', JSON.stringify(body, null, 2));

  if (body.object === 'whatsapp_business_account') {
    // TODO: In Phase 2, we will extract the message and pass it to messageHandler.
    // const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    // if (message) {
    //   handleMessage(message);
    // }
  }

  // We must send a 200 OK response back to Meta immediately.
  // Failing to do so will result in the webhook being disabled.
  res.sendStatus(200);
});

export default router;
