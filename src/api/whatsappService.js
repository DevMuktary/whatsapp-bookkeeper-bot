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
 * Sends a document (like a PDF) to the user using a media ID.
 * @param {string} to The recipient's WhatsApp ID.
 * @param {string} mediaId The ID of the uploaded media.
 * @param {string} filename The desired filename for the document.
 * @param {string} caption A short description of the document.
 */
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

/**
 * Sends an interactive message with up to 3 buttons.
 * @param {string} to The recipient's WhatsApp ID.
 * @param {string} bodyText The main text of the message.
 * @param {Array<object>} buttons An array of button objects, e.g., [{id: 'yes_btn', title: 'Yes'}]
 */
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

/**
 * Sends an interactive list message.
 * @param {string} to The recipient's WhatsApp ID.
 * @param {string} headerText The header text for the entire list.
 * @param {string} bodyText The main text content of the message.
 * @param {string} buttonText The text on the button that opens the list.
 * @param {Array<object>} sections An array of section objects. Each section has a title and rows.
 */
export async function sendInteractiveList(to, headerText, bodyText, buttonText, sections) {
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            header: {
                type: 'text',
                text: headerText
            },
            body: {
                text: bodyText
            },
            action: {
                button: buttonText,
                sections: sections
            }
        }
    };
    await sendMessage(data);
}
