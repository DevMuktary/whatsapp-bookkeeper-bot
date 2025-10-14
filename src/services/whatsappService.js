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

        if (message.type === 'text') {
            return { from, text: message.text.body, type: 'text' };
        }
        
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
        await axios.post(
            `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual', // BEST PRACTICE: Added for clarity and compliance
                to: to,
                type: 'text',
                text: { body: text }
            },
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
    } catch (error) {
        console.error("Error sending message:", error.response?.data?.error?.message || error.message);
    }
}

/**
 * Sends an interactive message with up to 3 buttons.
 */
export async function sendInteractiveMessage(to, bodyText, buttons) {
    if (!WHATSAPP_TOKEN) return console.error("Cannot send interactive message: WhatsApp token not configured.");
    if (buttons.length > 3) return console.error("Cannot send interactive message: A maximum of 3 buttons is allowed.");

    try {
        await axios.post(
            `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual', // BEST PRACTICE: Added for clarity and compliance
                to: to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: bodyText },
                    action: {
                        buttons: buttons.map(btn => ({
                            type: 'reply',
                            reply: { id: btn.id, title: btn.title }
                        }))
                    }
                }
            },
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
    } catch (error) {
        console.error("Error sending interactive message:", error.response?.data?.error?.message || error.message);
    }
}


/**
 * Sends a PDF document by first uploading it to get a media ID.
 */
export async function sendDocument(to, documentBuffer, fileName, caption) {
    if (!WHATSAPP_TOKEN) return console.error("Cannot send document: WhatsApp token not configured.");

    try {
        // --- Step 1: Upload the media ---
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('file', documentBuffer, {
            filename: fileName,
            contentType: 'application/pdf',
        });

        const uploadResponse = await axios.post(
            `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/media`,
            form,
            { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );

        const mediaId = uploadResponse.data.id;
        console.log(`✅ Successfully uploaded document. Media ID: ${mediaId}`);

        // --- Step 2: Send the document message using the media ID ---
        await axios.post(
            `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual', // THE FIX: This field is crucial for sending media messages.
                to: to,
                type: 'document',
                document: {
                    id: mediaId,
                    filename: fileName,
                    caption: caption
                }
            },
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
        console.log(`✅ Successfully sent document to ${to}`);
    } catch (error) {
        // More detailed error logging
        if (error.response) {
            console.error("Error sending document:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Error sending document:", error.message);
        }
    }
}
