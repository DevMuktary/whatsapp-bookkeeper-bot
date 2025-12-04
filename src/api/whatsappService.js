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

export async function setTypingIndicator(to, action, messageId = null) {
    if (!messageId) {
        return;
    }
    try {
        const payload = { 
            messaging_product: 'whatsapp', 
            status: 'read', 
            message_id: messageId 
        };

        if (action === 'on') {
            payload.typing_indicator = { type: 'text' };
        }

        await axios.post(`${WHATSAPP_GRAPH_URL}/${config.whatsapp.phoneNumberId}/messages`, payload, {
            headers: {
                'Authorization': `Bearer ${config.whatsapp.token}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        logger.error('Error setting typing indicator:', error.response ? error.response.data : error.message);
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
  // Guard clause to prevent the (#100) error if text is empty/null
  if (!text) {
      logger.warn('Attempted to send empty text message. Skipping.');
      return;
  }

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
  const formattedButtons = buttons.slice(0, 3).map(btn => ({ 
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

// Function to send the Onboarding Flow
export async function sendOnboardingFlow(to) {
    if (!config.whatsapp.onboardingFlowId) {
        logger.error("Onboarding Flow ID is missing in config.");
        await sendTextMessage(to, "Setup is currently unavailable. Please try again later.");
        return;
    }

    const data = {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
            type: "flow",
            header: {
                type: "text",
                text: "Welcome to Fynax Bookkeeper! 📊"
            },
            body: {
                text: "Please set up your account to start logging sales."
            },
            footer: {
                text: "Takes 30 seconds"
            },
            action: {
                name: "flow",
                parameters: {
                    mode: "published", 
                    flow_message_version: "3",
                    flow_token: "onboarding_token",
                    flow_id: config.whatsapp.onboardingFlowId, // [UPDATED]
                    flow_cta: "🚀 Setup Account",
                    flow_action: "navigate",
                    flow_action_payload: {
                        screen: "SIGN_UP_SCREEN"
                    }
                }
            }
        }
    };
    await sendMessage(data);
}

// Function to send the ADD BANK Flow
export async function sendAddBankFlow(to) {
    if (!config.whatsapp.bankFlowId) {
        logger.error("Bank Flow ID is missing in config.");
        await sendTextMessage(to, "Bank setup is currently unavailable.");
        return;
    }

    const data = {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
            type: "flow",
            header: {
                type: "text",
                text: "Add Bank Account 🏦"
            },
            body: {
                text: "Add a new bank or mobile money account to track your balances."
            },
            footer: {
                text: "Secure & Private"
            },
            action: {
                name: "flow",
                parameters: {
                    mode: "published", 
                    flow_message_version: "3",
                    flow_token: "add_bank_token",
                    flow_id: config.whatsapp.bankFlowId, // [UPDATED] Uses the dedicated Bank Flow ID
                    flow_cta: "➕ Add Account",
                    flow_action: "navigate",
                    flow_action_payload: {
                        screen: "ADD_BANK_SCREEN"
                    }
                }
            }
        }
    };
    await sendMessage(data);
}

export async function sendMainMenu(to) {
    const sections = [
        {
            title: "Main Options",
            rows: [
                { id: 'log a sale', title: '✍️ Log a Sale', description: 'Record a new sale transaction.' },
                { id: 'log an expense', title: '💸 Log an Expense', description: 'Record a new business expense.' },
                { id: 'add a product', title: '📦 Add/Restock Product', description: 'Add a new item or update stock.' },
                { id: 'generate report', title: '📊 Generate a Report', description: 'Get a PDF report for your business.' },
                { id: 'get financial insight', title: '💡 Get Financial Insight', description: 'Receive an AI-powered tip.' },
                { id: 'edit a transaction', title: '✏️ Edit/Delete a Record', description: 'Correct a previous entry.' },
                { id: 'log a customer payment', title: '💰 Log Customer Payment', description: 'Record a payment from a customer.' },
                { id: 'manage bank accounts', title: '🏦 Manage Bank Accounts', description: 'Add or check bank balances.' },
            ]
        }
    ];

    await sendInteractiveList(to,
        'Main Menu',
        'Hello! What would you like to do? You can select an option from the menu or just type your request.',
        'Show Menu',
        sections
    );
}

export async function sendReportMenu(to) {
    const sections = [
        {
            title: "Available Reports",
            rows: [
                { id: 'generate sales report', title: 'Sales Report', description: 'Get a PDF of all sales.' },
                { id: 'generate expense report', title: 'Expense Report', description: 'Get a PDF of all expenses.' },
                { id: 'generate p&l report', title: 'Profit & Loss Report', description: 'See your revenue, costs, and profit.' },
                { id: 'generate cogs report', title: 'Cost of Sales Report', description: 'View cost of goods sold.' },
                { id: 'generate inventory report', title: 'Inventory Report', description: 'Get a PDF of your current stock.' },
            ]
        }
    ];

    await sendInteractiveList(to,
        'Generate Report',
        'Which report would you like to generate? Please choose from the list.',
        'Select Report',
        sections
    );
}
