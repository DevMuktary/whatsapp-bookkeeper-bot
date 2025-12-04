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
        const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        const mediaUrl = urlRes.data.url;

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

// --- VOICE & VISION ---

export async function transcribeAudio(mediaId) {
    try {
        const audioBuffer = await downloadWhatsAppMedia(mediaId);
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

export async function analyzeImage(mediaId, caption = "") {
    try {
        const imageBuffer = await downloadWhatsAppMedia(mediaId);
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Extract relevant bookkeeping details from this image. If it's a receipt, list items, total amount, and date. If it's a product, describe it. User caption: "${caption}"` },
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

// --- TEXT PARSING HELPERS ---

const parsePrice = (priceInput) => {
    if (typeof priceInput === 'number') return priceInput;
    if (typeof priceInput !== 'string') return NaN;

    const cleaned = priceInput.replace(/₦|,/g, '').toLowerCase().trim();
    let multiplier = 1;
    let numericPart = cleaned;

    if (cleaned.endsWith('k')) {
        multiplier = 1000;
        numericPart = cleaned.slice(0, -1);
    } else if (cleaned.endsWith('m')) {
        multiplier = 1000000;
        numericPart = cleaned.slice(0, -1);
    }

    const value = parseFloat(numericPart);
    return isNaN(value) ? NaN : value * multiplier;
};

async function callDeepSeek(messages, temperature = 0.1, enforceJson = true) {
  try {
    const payload = {
      model: 'deepseek-chat',
      messages: messages,
      temperature: temperature,
    };
    
    if (enforceJson && messages.some(m => m.role === 'system' && m.content.toLowerCase().includes('json'))) {
        payload.response_format = { type: "json_object" };
    }

    const response = await axios.post(DEEPSEEK_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseek.apiKey}`
      }
    });

    const content = response.data.choices[0].message.content;

    if (enforceJson && typeof content === 'string' && content.trim().startsWith('{')) {
         try {
             return JSON.parse(content);
         } catch (parseError) {
             logger.warn("AI response looked like JSON but failed to parse:", content);
             return content;
         }
    }

    return content;

  } catch (error) {
    logger.error('Error calling DeepSeek API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    throw new Error('Failed to communicate with the AI service.');
  }
}

// --- CORE INTENT & ENTITY EXTRACTION ---

// [NEW] Bulk Product Parser
export async function parseBulkProductList(text) {
    const systemPrompt = `You are a data extraction assistant.
    TASK: Convert the user's product list text into a JSON array.
    
    INPUT FORMAT EXAMPLES:
    - "5 rice 2000 2500" (Qty, Name, Cost, Sell)
    - "10 bags of cement, cost 5k, sell 6k"
    - "Milk: 20 pcs, cp=500, sp=600"

    OUTPUT FORMAT:
    Return ONLY a JSON object: { "products": [ { "productName": "...", "quantityAdded": 10, "costPrice": 5000, "sellingPrice": 6000 } ] }
    
    RULES:
    1. If price is missing, set to 0.
    2. If quantity is missing, set to 1.
    3. Clean up product names (remove emoji, capitalize).
    `;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    const response = await callDeepSeek(messages, 0.1, true);
    return response.products || [];
}

export async function extractOnboardingDetails(text) {
  const messages = [
    {
      role: 'system',
      content: "You are an expert entity extractor. Respond ONLY with a JSON object: {\"businessName\": \"Name\", \"email\": \"user@example.com\"}. If not found, use null."
    },
    { role: 'user', content: text }
  ];
  return await callDeepSeek(messages);
}

export async function extractCurrency(text) {
    const messages = [
        {
            role: 'system',
            content: "Identify the currency and return ISO 4217 code. JSON: {\"currency\": \"ISO_CODE\"}. Example: 'Naira' -> 'NGN'."
        },
        { role: 'user', content: text }
    ];
    return await callDeepSeek(messages);
}

export async function getIntent(text) {
    const today = new Date().toISOString().split('T')[0];
    const systemPrompt = `You are an intent classifier. Respond ONLY with JSON.
    TODAY: ${today}

    INTENTS:
    - ${INTENTS.LOG_SALE}: "Sold 5 rice", "Credit sale"
    - ${INTENTS.LOG_EXPENSE}: "Bought fuel", "Paid rent"
    - ${INTENTS.ADD_PRODUCT}: "Restock rice", "New item"
    - ${INTENTS.ADD_PRODUCTS_FROM_LIST}: "Add these: 1. Rice, 2. Beans" (Multi-line or bulk list)
    - ${INTENTS.ADD_MULTIPLE_PRODUCTS}: "I want to add many items"
    - ${INTENTS.CHECK_STOCK}: "How many rice left?"
    - ${INTENTS.GENERATE_REPORT}: "Send me a report", "P&L", "Sales report"
    - ${INTENTS.GET_FINANCIAL_SUMMARY}: "Total sales today"
    - ${INTENTS.ADD_BANK_ACCOUNT}: "Add bank UBA"
    - ${INTENTS.LOG_CUSTOMER_PAYMENT}: "John paid 5000"
    - ${INTENTS.GENERAL_CONVERSATION}: "Hello", "Thanks", "Hi"
    - ${INTENTS.SHOW_MAIN_MENU}: "Menu", "Cancel"
    - ${INTENTS.RECONCILE_TRANSACTION}: "Edit transaction", "Delete sale"
    - ${INTENTS.GET_CUSTOMER_BALANCES}: "Who owes me?"

    RULES:
    1. If Intent is ${INTENTS.GENERATE_REPORT}:
       - Context MUST include "reportType": "SALES", "EXPENSES", "PNL", "INVENTORY", or "COGS".
       - Dates: Calculate "startDate" and "endDate" (YYYY-MM-DD). Default "this_month".
    2. General Conversation: Provide "generatedReply".

    Return JSON: {"intent": "...", "context": {...}}
    `;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    let result = await callDeepSeek(messages);
    
    if (result.context) {
        if (result.context.amount) result.context.amount = parsePrice(result.context.amount);
        if (result.context.totalAmount) result.context.totalAmount = parsePrice(result.context.totalAmount);
        if (result.context.amountPerUnit) result.context.amountPerUnit = parsePrice(result.context.amountPerUnit);
        if (result.context.unitsSold) result.context.unitsSold = parseInt(result.context.unitsSold, 10) || 1;
        if (result.context.openingBalance) result.context.openingBalance = parsePrice(result.context.openingBalance);
    }
    
    return result;
}

export async function getFinancialInsight(pnlData, currency) {
    const systemPrompt = `Analyze this P&L data and give one friendly business tip. Data: ${JSON.stringify(pnlData)}`;
    const messages = [{ role: 'system', content: systemPrompt }];
    return await callDeepSeek(messages, 0.7, false);
}

export async function gatherSaleDetails(conversationHistory, existingProduct = null, isService = false) { 
    const productInfo = isService 
        ? "Service sale." 
        : (existingProduct ? `Product: "${existingProduct.productName}", Price: ${existingProduct.sellingPrice}.` : 'New product.');

    const systemPrompt = `Bookkeeping assistant logging a sale.
    CONTEXT: ${productInfo}
    GOAL: Collect 'items' (array of {productName, quantity, pricePerUnit}), 'customerName', 'saleType'.
    Return JSON: {"status": "complete"/"incomplete", "data": {...}, "reply": "..."}`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);
    
    if (response.status === 'complete' && response.data && response.data.items) {
        response.data.items = response.data.items.map(item => ({
            ...item,
            pricePerUnit: parsePrice(item.pricePerUnit),
            quantity: item.quantity ? parseInt(item.quantity, 10) : 1
        }));
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}

export async function gatherExpenseDetails(conversationHistory) {
    const systemPrompt = `Log expense (Category, Amount, Description).
    Auto-Categorize if possible.
    Return JSON: {"status": "complete"/"incomplete", "data": {...}, "reply": "..."}`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
        response.data.amount = parsePrice(response.data.amount);
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}

export async function gatherProductDetails(conversationHistory, existingProduct = null) {
    const existingDataInfo = existingProduct 
        ? `Existing: Cost ${existingProduct.costPrice}, Sell ${existingProduct.sellingPrice}.`
        : 'New product.';

    const systemPrompt = `Inventory Manager. Add/Update product (productName, quantityAdded, costPrice, sellingPrice).
    CONTEXT: ${existingDataInfo}
    Return JSON: {"status": "complete"/"incomplete", ...}`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
         response.data.costPrice = parsePrice(response.data.costPrice);
         response.data.sellingPrice = parsePrice(response.data.sellingPrice);
         response.data.quantityAdded = parseInt(response.data.quantityAdded, 10);
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}

export async function gatherPaymentDetails(conversationHistory, userCurrency) {
    const systemPrompt = `Log Customer Payment. Need: "customerName", "amount". Currency: ${userCurrency}.
    Return JSON.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
        response.data.amount = parsePrice(response.data.amount);
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}

export async function gatherBankAccountDetails(conversationHistory, userCurrency) {
    const systemPrompt = `Add Bank Account. Need: "bankName", "openingBalance". Currency: ${userCurrency}.
    Return JSON.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
        response.data.openingBalance = parsePrice(response.data.openingBalance);
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}
