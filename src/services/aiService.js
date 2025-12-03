import axios from 'axios';
import OpenAI from 'openai';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { INTENTS } from '../utils/constants.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Downloads media (audio/image) from WhatsApp servers.
 */
async function downloadWhatsAppMedia(mediaId) {
    try {
        // 1. Get URL
        const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        const mediaUrl = urlRes.data.url;

        // 2. Download Binary
        const mediaRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        return mediaRes.data;
    } catch (error) {
        logger.error('Error downloading media:', error.message);
        throw new Error('Failed to download media file.');
    }
}

/**
 * [NEW] Transcribes Voice Notes using OpenAI Whisper.
 */
export async function transcribeAudio(mediaId) {
    try {
        const audioBuffer = await downloadWhatsAppMedia(mediaId);
        // Create a File object-like structure for OpenAI
        const file = await OpenAI.toFile(audioBuffer, 'voice_note.ogg', { type: 'audio/ogg' });
        
        const transcription = await openai.audio.transcriptions.create({
            file: file,
            model: "whisper-1",
        });
        return transcription.text;
    } catch (error) {
        logger.error('Audio transcription failed:', error);
        return null;
    }
}

/**
 * [NEW] Analyzes Images (Receipts/Invoices) using OpenAI Vision.
 */
export async function analyzeImage(mediaId, caption = "") {
    try {
        const imageBuffer = await downloadWhatsAppMedia(mediaId);
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o", // Or gpt-4-turbo
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Extract relevant bookkeeping details from this image. If it's a receipt, list items, total amount, and date. If it's just a photo of a product, describe it. User caption: "${caption}"` },
                        { type: "image_url", image_url: { url: dataUrl } },
                    ],
                },
            ],
            max_tokens: 300,
        });
        return response.choices[0].message.content;
    } catch (error) {
        logger.error('Image analysis failed:', error);
        return null;
    }
}

// --- EXISTING DEEPSEEK LOGIC BELOW (Preserved) ---

const parsePrice = (priceInput) => {
    if (typeof priceInput === 'number') return priceInput;
    if (typeof priceInput !== 'string') return NaN;
    const cleaned = priceInput.replace(/₦|,/g, '').toLowerCase().trim();
    let multiplier = 1;
    let numericPart = cleaned;
    if (cleaned.endsWith('k')) { multiplier = 1000; numericPart = cleaned.slice(0, -1); } 
    else if (cleaned.endsWith('m')) { multiplier = 1000000; numericPart = cleaned.slice(0, -1); }
    const value = parseFloat(numericPart);
    return isNaN(value) ? NaN : value * multiplier;
};

async function callDeepSeek(messages, temperature = 0.1, enforceJson = true) {
  try {
    const payload = { model: 'deepseek-chat', messages, temperature };
    if (enforceJson && messages.some(m => m.role === 'system' && m.content.toLowerCase().includes('json'))) {
        payload.response_format = { type: "json_object" };
    }
    const response = await axios.post(DEEPSEEK_API_URL, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.deepseek.apiKey}` }
    });
    const content = response.data.choices[0].message.content;
    if (enforceJson && typeof content === 'string' && content.trim().startsWith('{')) {
         try { return JSON.parse(content); } catch (e) { return content; }
    }
    return content;
  } catch (error) {
    logger.error('DeepSeek API Error:', error.message);
    throw new Error('AI service unavailable.');
  }
}

export async function extractOnboardingDetails(text) {
  const messages = [{ role: 'system', content: "Extract {\"businessName\": \"...\", \"email\": \"...\"} from text. Return JSON." }, { role: 'user', content: text }];
  return await callDeepSeek(messages);
}

export async function extractCurrency(text) {
    const messages = [{ role: 'system', content: "Identify currency ISO code (e.g. NGN, USD). Return JSON {\"currency\": \"CODE\"}." }, { role: 'user', content: text }];
    return await callDeepSeek(messages);
}

export async function getIntent(text) {
    const today = new Date().toISOString().split('T')[0];
    const systemPrompt = `Identify intent from text. TODAY: ${today}.
    Intents: ${Object.values(INTENTS).join(', ')}.
    Return JSON: {"intent": "...", "context": {...}}.`;
    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    let result = await callDeepSeek(messages);
    
    // Quick cleanup
    if (result.context?.amount) result.context.amount = parsePrice(result.context.amount);
    if (result.context?.totalAmount) result.context.totalAmount = parsePrice(result.context.totalAmount);
    return result;
}

export async function getFinancialInsight(pnlData, currency) {
    // Note: Passed to DeepSeek for creative insight
    const messages = [{ role: 'system', content: `Analyze this P&L data and give one friendly insight: ${JSON.stringify(pnlData)}` }];
    return await callDeepSeek(messages, 0.7, false);
}

// ... (Existing gather* functions remain same, just ensure they are exported) ...
export async function gatherSaleDetails(history, existingProduct, isService) { /* ... same as before ... */ 
    const systemPrompt = `Collect sale details (items, customerName, saleType). Items need productName, quantity, pricePerUnit. Return JSON.`;
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    return await callDeepSeek(messages, 0.5); 
}
export async function gatherExpenseDetails(history) { /* ... same as before ... */
    const systemPrompt = `Collect expense details (category, amount, description). Auto-categorize. Return JSON.`;
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    return await callDeepSeek(messages, 0.5); 
}
export async function gatherProductDetails(history, existingProduct) { /* ... same as before ... */
    const systemPrompt = `Collect product details (productName, quantityAdded, costPrice, sellingPrice). Return JSON.`;
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    return await callDeepSeek(messages, 0.5); 
}
export async function gatherPaymentDetails(history, cur) { /* ... same as before ... */ 
    const systemPrompt = `Collect payment details (customerName, amount). Return JSON.`;
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    return await callDeepSeek(messages, 0.5); 
}
export async function gatherBankAccountDetails(history, cur) { /* ... same as before ... */ 
    const systemPrompt = `Collect bank details (bankName, openingBalance). Return JSON.`;
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    return await callDeepSeek(messages, 0.5); 
}
