import axios from 'axios';

// Get credentials from environment variables
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Check if credentials are set
if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error("WhatsApp environment variables are not set. Please check WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
    // In a real app, you might throw an error, but for Railway's restart policy, console logging is fine.
}

const GRAPH_API_VERSION = 'v19.0'; // Use a recent, stable version
const GRAPH_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Parses the incoming webhook payload from Meta to extract the user's message.
 * @param {object} body - The body of the webhook POST request.
 * @returns {object|null} A simple object with { from, text } or null if it's not a text message.
 */
export function parseWebhookMessage(body) {
    // Check if the webhook is a message notification
    if (
        body.object &&
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0] &&
        body.entry[0].changes[0].value.messages &&
        body.entry[0].changes[0].value.messages[0]
    ) {
        const message = body.entry[0].changes[0].value.messages[0];

        // We only care about text messages for now
        if (message.type === 'text') {
            return {
                from: message.from,       // The user's WhatsApp number (e.g., '234810...')
                text: message.text.body   // The message they sent
            };
        }
    }
    // Return null if it's not a text message we can handle
    return null;
}

/**
 * Sends a text message to a user via the Meta Graph API.
 * @param {string} to - The recipient's WhatsApp number.
 * @param {string} text - The message to send.
 */
export async function sendMessage(to, text) {
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error("Cannot send message: WhatsApp credentials are not configured.");
        return;
    }

    try {
        await axios({
            method: 'POST',
            url: `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: {
                    body: text
                }
            }
        });
    } catch (error) {
        console.error("Error sending message:", error.response ? error.response.data : error.message);
    }
}

// NOTE: We will add a 'sendDocument' function here in a later step.
