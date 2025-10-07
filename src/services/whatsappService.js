import axios from 'axios';
import FormData from 'form-data';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error("WhatsApp environment variables are not set.");
}

const GRAPH_API_VERSION = 'v19.0';
const GRAPH_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Parses incoming webhooks to extract user messages OR button clicks.
 */
export function parseWebhookMessage(body) {
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from;

        // Check for a regular text message
        if (message.type === 'text') {
            return { from, text: message.text.body, type: 'text' };
        }
        
        // Check for an interactive button reply
        if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
            return { from, text: message.interactive.button_reply.title, buttonId: message.interactive.button_reply.id, type: 'button_reply' };
        }
    }
    return null;
}

/**
 * Sends a simple text message.
 */
export async function sendMessage(to, text) {
    if (!WHATSAPP_TOKEN) return console.error("Cannot send message: WhatsApp token not configured.");
    try {
        await axios({
            method: 'POST',
            url: `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
            data: { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: text } }
        });
    } catch (error) {
        console.error("Error sending message:", error.response?.data);
    }
}

/**
 * NEW: Sends an interactive message with up to 3 buttons.
 * @param {string} to - The recipient's WhatsApp number.
 * @param {string} bodyText - The main text of the message.
 * @param {Array<{id: string, title: string}>} buttons - An array of button objects. Max 3.
 */
export async function sendInteractiveMessage(to, bodyText, buttons) {
    if (!WHATSAPP_TOKEN) return console.error("Cannot send interactive message: WhatsApp token not configured.");
    
    // WhatsApp allows a maximum of 3 buttons.
    if (buttons.length > 3) {
        console.error("Cannot send interactive message: A maximum of 3 buttons is allowed.");
        return;
    }

    try {
        await axios({
            method: 'POST',
            url: `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: {
                        text: bodyText
                    },
                    action: {
                        buttons: buttons.map(btn => ({
                            type: 'reply',
                            reply: {
                                id: btn.id,
                                title: btn.title
                            }
                        }))
                    }
                }
            }
        });
    } catch (error) {
        console.error("Error sending interactive message:", error.response?.data);
    }
}


/**
 * Sends a PDF document.
 */
export async function sendDocument(to, documentBuffer, fileName, caption) {
    // ... This function is unchanged, but should be present in your file.
    if (!WHATSAPP_TOKEN) return console.error("Cannot send document: WhatsApp token not configured.");
    try {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('file', documentBuffer, { filename: fileName, contentType: 'application/pdf' });
        const uploadResponse = await axios.post(
            `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/media`,
            form,
            { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
        const mediaId = uploadResponse.data.id;
        await axios({
            method: 'POST',
            url: `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                type: 'document',
                document: { id: mediaId, filename: fileName, caption: caption }
            }
        });
    } catch (error) {
        console.error("Error sending document:", error.response ? error.response.data.error : error.message);
    }
}
