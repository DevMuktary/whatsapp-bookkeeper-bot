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

/**
 * Sends a structured main menu of options to the user.
 * @param {string} to The recipient's WhatsApp ID.
 */
export async function sendMainMenu(to) {
    const sections = [
        {
            title: "📊 Reporting & Insights",
            rows: [
                { id: 'generate sales report', title: 'Sales Report', description: 'Get a PDF report of your sales.' },
                { id: 'generate expense report', title: 'Expense Report', description: 'Get a PDF report of your expenses.' },
                { id: 'generate inventory report', title: 'Inventory Report', description: 'Get a PDF of your current stock.' },
                { id: 'generate p&l report', title: 'Profit & Loss Report', description: 'See your revenue, costs, and net profit.' },
                { id: 'get financial insight', title: 'Get Financial Insight', description: 'Receive an AI-powered tip for your business.' }
            ]
        },
        {
            title: "✍️ Data Entry",
            rows: [
                { id: 'log a sale', title: 'Log a Sale', description: 'Record a new sale.' },
                { id: 'log an expense', title: 'Log an Expense', description: 'Record a new business expense.' },
                { id: 'add a new product', title: 'Add a Product', description: 'Add a single new item to inventory.' },
                { id: 'log a customer payment', title: 'Log Customer Payment', description: 'Record a payment from a customer.' },
            ]
        },
        {
            title: "⚙️ Management",
            rows: [
                { id: 'edit a transaction', title: 'Edit/Delete Transaction', description: 'Correct a mistake in your records.' },
                { id: 'add a bank account', title: 'Add a Bank Account', description: 'Set up a new bank account.' },
                { id: 'check bank balance', title: 'Check Bank Balance', description: 'View current account balances.' },
            ]
        }
    ];

    await sendInteractiveList(to,
        'Main Menu',
        'What would you like to do next? You can select an option from the menu or type your request.',
        'Show Menu',
        sections
    );
}
