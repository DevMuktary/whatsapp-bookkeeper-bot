import axios from 'axios';
import FormData from 'form-data';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const WHATSAPP_GRAPH_URL = 'https://graph.facebook.com/v20.0';

async function sendMessage(data) {
  try {
    await axios.post(`${WHATSAPP_GRAPH_URL}/${config.whatsapp.phoneNumberId}/messages`, data, {
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
 * Uploads a media file to WhatsApp servers to get a media ID.
 * @param {Buffer} buffer The file buffer.
 * @param {string} mimeType The MIME type of the file (e.g., 'application/pdf').
 * @returns {Promise<string|null>} The media ID or null if failed.
 */
export async function uploadMedia(buffer, mimeType) {
    try {
        const form = new FormData();
        form.append('file', buffer, { contentType: mimeType, filename: 'report.pdf' });
        form.append('messaging_product', 'whatsapp');

        const response = await axios.post(`${WHATSAPP_GRAPH_URL}/${config.whatsapp.phoneNumberId}/media`, form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${config.whatsapp.token}`,
            }
        });
        logger.info('Media uploaded successfully.');
        return response.data.id;
    } catch (error) {
        logger.error('Error uploading WhatsApp media:', error.response ? error.response.data : error.message);
        return null;
    }
}

export async function sendTextMessage(to, text) {
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };
  await sendMessage(data);
}

export async function sendDocument(to, mediaId, filename, caption) {
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: {
            id: mediaId,
            filename,
            caption
        }
    };
    await sendMessage(data);
}

export async function sendInteractiveButtons(to, bodyText, buttons) {
  const formattedButtons = buttons.map(btn => ({
    type: 'reply',
    reply: { id: btn.id, title: btn.title }
  }));

  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: formattedButtons }
    }
  };
  await sendMessage(data);
}
