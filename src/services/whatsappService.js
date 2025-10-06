import axios from 'axios';
import FormData from 'form-data';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error("WhatsApp environment variables are not set.");
}

const GRAPH_API_VERSION = 'v19.0';
const GRAPH_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export function parseWebhookMessage(body) {
    if (
        body.object &&
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    ) {
        const message = body.entry[0].changes[0].value.messages[0];
        if (message.type === 'text') {
            return {
                from: message.from,
                text: message.text.body
            };
        }
    }
    return null;
}

export async function sendMessage(to, text) {
    if (!WHATSAPP_TOKEN) return console.error("Cannot send message: WhatsApp token not configured.");
    try {
        await axios({
            method: 'POST',
            url: `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: text }
            }
        });
    } catch (error) {
        console.error("Error sending message:", error.response ? error.response.data : error.message);
    }
}

export async function sendDocument(to, documentBuffer, fileName, caption) {
    if (!WHATSAPP_TOKEN) return console.error("Cannot send document: WhatsApp token not configured.");
    try {
        // Step 1: Upload the media
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

        // Step 2: Send the media message
        await axios({
            method: 'POST',
            url: `${GRAPH_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                type: 'document',
                document: {
                    id: mediaId,
                    filename: fileName,
                    caption: caption
                }
            }
        });
    } catch (error) {
        console.error("Error sending document:", error.response ? error.response.data.error : error.message);
    }
}
