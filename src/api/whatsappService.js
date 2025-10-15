import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const WHATSAPP_API_URL = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;

/**
 * A generic function to send a message payload to the WhatsApp API.
 * @param {object} data The message payload.
 */
async function sendMessage(data) {
  try {
    await axios.post(WHATSAPP_API_URL, data, {
      headers: {
        'Authorization': `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    logger.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
  }
}

/**
 * Sends a simple text message.
 * @param {string} to The recipient's WhatsApp ID.
 * @param {string} text The content of the message.
 */
export async function sendTextMessage(to, text) {
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };
  await sendMessage(data);
}

/**
 * Sends an interactive message with buttons.
 * @param {string} to The recipient's WhatsApp ID.
 * @param {string} bodyText The main text of the message.
 * @param {Array<object>} buttons An array of button objects, e.g., [{id: 'yes_btn', title: 'Yes'}]
 */
export async function sendInteractiveButtons(to, bodyText, buttons) {
  const formattedButtons = buttons.map(btn => ({
    type: 'reply',
    reply: {
      id: btn.id,
      title: btn.title
    }
  }));

  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: bodyText
      },
      action: {
        buttons: formattedButtons
      }
    }
  };
  await sendMessage(data);
}
