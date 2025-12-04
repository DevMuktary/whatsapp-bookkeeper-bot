import axios from 'axios';
import OpenAI from 'openai';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { INTENTS } from '../utils/constants.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const openai = new OpenAI({ apiKey: config.openai.apiKey });

// --- MEDIA HELPERS ---

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

export async function transcribeAudio(mediaId) {
    try {
        const audioBuffer = await downloadWhatsAppMedia(mediaId);
        // Create a File-like object for OpenAI
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
    
    // Only add response_format if enforceJson is true AND the prompt requests JSON
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

    // JSON Parsing Logic
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
      content: "You are an expert entity extractor. Your task is to extract a business name and an email address from the user's message. Respond ONLY with a JSON object in the format {\"businessName\": \"The Extracted Name\", \"email\": \"user@example.com\"}. If a piece of information is not found, its value should be null."
    },
    { role: 'user', content: `Here is the message: "${text}"` }
  ];
  const responseJson = await callDeepSeek(messages);
  return typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
}

export async function extractCurrency(text) {
    const messages = [
        {
            role: 'system',
            content: "You are an expert currency identification system. Your task is to identify the currency mentioned in the user's text and convert it to its standard 3-letter ISO 4217 code. Examples: 'Naira' or '₦' -> 'NGN', 'US dollars' or '$' -> 'USD', 'Ghana Cedis' -> 'GHS', 'pounds' -> 'GBP'. Respond ONLY with a JSON object in the format {\"currency\": \"ISO_CODE\"}. If no currency is found, the value should be null."
        },
        { role: 'user', content: `Here is the message: "${text}"` }
    ];
    const responseJson = await callDeepSeek(messages);
    return typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
}

export async function getIntent(text) {
    const today = new Date().toISOString().split('T')[0];
    const systemPrompt = `You are an intent classifier. Respond ONLY with JSON.
    TODAY: ${today}

    INTENTS:
    - ${INTENTS.LOG_SALE}: "Sold 5 rice", "Credit sale to John"
    - ${INTENTS.LOG_EXPENSE}: "Bought fuel 500", "Paid shop rent"
    - ${INTENTS.ADD_PRODUCT}: "Restock rice 50 bags", "New item indomie 2000"
    - ${INTENTS.ADD_PRODUCTS_FROM_LIST}: "Add these: 1. Rice, 2. Beans" (Multi-line or bulk list)
    - ${INTENTS.ADD_MULTIPLE_PRODUCTS}: "I want to add many items"
    - ${INTENTS.CHECK_STOCK}: "How many rice left?", "Count stock"
    - ${INTENTS.GENERATE_REPORT}: "Send me a report", "Expense report", "Sales report", "P&L", "Profit and Loss", "Report for last month"
    - ${INTENTS.GET_FINANCIAL_SUMMARY}: "Total sales today", "How much did I spend?"
    - ${INTENTS.ADD_BANK_ACCOUNT}: "Add bank UBA", "New account access bank"
    - ${INTENTS.LOG_CUSTOMER_PAYMENT}: "John paid 5000", "Receive payment from Sarah"
    - ${INTENTS.GENERAL_CONVERSATION}: "Hello", "Thanks", "Who are you?", "Hi"
    - ${INTENTS.SHOW_MAIN_MENU}: "Menu", "Show options", "Cancel"
    - ${INTENTS.RECONCILE_TRANSACTION}: "Edit transaction", "Delete sale", "I made a mistake"
    - ${INTENTS.GET_CUSTOMER_BALANCES}: "Who owes me?", "Debtors list"

    RULES:
    1. If Intent is ${INTENTS.GENERATE_REPORT}:
       - Context MUST include "reportType": "SALES", "EXPENSES", "PNL", "INVENTORY", or "COGS".
       - Example: "Expense report" -> {"intent": "${INTENTS.GENERATE_REPORT}", "context": {"reportType": "EXPENSES"}}
       - If unspecified ("Generate report"), "reportType" is null.
    
    2. Dates: Calculate "startDate" and "endDate" (YYYY-MM-DD) based on user input (e.g., "last month", "today"). Default to "this_month".

    3. General Conversation:
       - If the user says "Hello" or asks a question, set intent to ${INTENTS.GENERAL_CONVERSATION}.
       - You MUST provide a "generatedReply" string in the context.

    Return JSON format: {"intent": "...", "context": {...}}
    `;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    let result = await callDeepSeek(messages);
    
    // Post-processing to clean up extracted numbers
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
    const systemPrompt = `Analyze this P&L data and give one friendly, short business tip. Data: ${JSON.stringify(pnlData)}`;
    const messages = [{ role: 'system', content: systemPrompt }];
    return await callDeepSeek(messages, 0.7, false);
}

// [UPDATED] Now extracts 'dueDate' for credit sales
export async function gatherSaleDetails(conversationHistory, existingProduct = null, isService = false) { 
    const today = new Date().toISOString().split('T')[0];
    const productInfo = isService 
        ? "The user confirmed this is a service." 
        : (existingProduct ? `Existing product: "${existingProduct.productName}", Price: ${existingProduct.sellingPrice}.` : 'New product/service.');

    const systemPrompt = `You are a bookkeeping assistant logging a sale. TODAY: ${today}.
    CONTEXT: ${productInfo}
    GOAL: Collect 'items' (array of {productName, quantity, pricePerUnit}), 'customerName', and 'saleType' (Cash/Credit/Bank).
    
    RULES:
    1. Extract details. Default quantity is 1.
    2. If product exists, use its price if user doesn't specify.
    3. Once you have an item, add it to 'items'.
    4. If 'saleType' is CREDIT, listen closely for a due date (e.g., "pay next friday", "due 25th").
    5. If mentioned, calculate 'dueDate' as YYYY-MM-DD.
    6. Ask "Anything else?" after adding items.
    7. ONLY when user says "done"/"no", return {"status": "complete", "data": {...}}.
    8. Otherwise return {"status": "incomplete", "reply": "Next question..."}.
    
    Return JSON format:
    {"status": "complete"/"incomplete", "data": {"items": [], "customerName": "...", "saleType": "...", "dueDate": "YYYY-MM-DD"}, "reply": "..."}`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);
    
    // Ensure numeric values
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
    const systemPrompt = `You are a smart bookkeeping assistant. Goal: Log expense (Category, Amount, Description).
    RULES:
    1. **Auto-Categorize** based on description (e.g. "fuel" -> "Transportation").
    2. Return {"status": "complete", "data": {"category": "...", "amount": "...", "description": "..."}} when ready.
    3. Otherwise {"status": "incomplete", "reply": "Question..."}.
    Return JSON.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
        response.data.amount = parsePrice(response.data.amount);
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}

// [UPDATED] Prompt now asks for 'reorderLevel'
export async function gatherProductDetails(conversationHistory, existingProduct = null) {
    const existingDataInfo = existingProduct 
        ? `Existing product: Cost ${existingProduct.costPrice}, Sell ${existingProduct.sellingPrice}.`
        : 'New product.';

    const systemPrompt = `Inventory Manager. Goal: Add/Update product.
    FIELDS: productName, quantityAdded, costPrice, sellingPrice, reorderLevel.
    CONTEXT: ${existingDataInfo}
    RULES:
    1. If user says "same price", use existing data.
    2. If user says "alert me at 10" or "warn when low", set "reorderLevel".
    3. Default reorderLevel is 5 if not specified.
    4. Return {"status": "complete", "data": {...}} when ready.
    5. Otherwise {"status": "incomplete", "reply": "..."}.
    Return JSON.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
         response.data.costPrice = parsePrice(response.data.costPrice);
         response.data.sellingPrice = parsePrice(response.data.sellingPrice);
         response.data.quantityAdded = parseInt(response.data.quantityAdded, 10);
         if (response.data.reorderLevel) {
             response.data.reorderLevel = parseInt(response.data.reorderLevel, 10);
         }
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}

export async function gatherPaymentDetails(conversationHistory, userCurrency) {
    const systemPrompt = `Log Customer Payment. Need: "customerName", "amount".
    Assume currency is ${userCurrency}.
    Return JSON: {"status": "complete"/"incomplete", ...}`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
        response.data.amount = parsePrice(response.data.amount);
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}

export async function gatherBankAccountDetails(conversationHistory, userCurrency) {
    const systemPrompt = `Add Bank Account. Need: "bankName", "openingBalance".
    Assume currency is ${userCurrency}.
    Return JSON: {"status": "complete"/"incomplete", ...}`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    let response = await callDeepSeek(messages, 0.5);

    if (response.status === 'complete' && response.data) {
        response.data.openingBalance = parsePrice(response.data.openingBalance);
    }
    return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
}
