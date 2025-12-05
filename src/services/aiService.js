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

// [NEW] Fallback Logic if AI Fails
function getFallbackIntent(text) {
    const t = text.toLowerCase();
    
    // Simple keyword matching for core intents
    if (t.includes('sold') || t.includes('sale') || t.includes('sell')) return { intent: INTENTS.LOG_SALE, context: {} };
    if (t.includes('bought') || t.includes('buy') || t.includes('expense') || t.includes('spent') || t.includes('paid')) return { intent: INTENTS.LOG_EXPENSE, context: {} };
    if (t.includes('stock') || t.includes('inventory') || t.includes('count')) return { intent: INTENTS.CHECK_STOCK, context: {} };
    if (t.includes('menu') || t.includes('start') || t.includes('hi') || t.includes('hello')) return { intent: INTENTS.SHOW_MAIN_MENU, context: {} };
    if (t.includes('balance') || t.includes('how much in')) return { intent: INTENTS.CHECK_BANK_BALANCE, context: {} };
    if (t.includes('owe') || t.includes('debt') || t.includes('debtor')) return { intent: INTENTS.GET_CUSTOMER_BALANCES, context: {} };
    if (t.includes('report') || t.includes('pdf')) return { intent: INTENTS.GENERATE_REPORT, context: {} };
    if (t.includes('insight') || t.includes('tip')) return { intent: INTENTS.GET_FINANCIAL_INSIGHT, context: {} };
    if (t.includes('join')) return { intent: INTENTS.GENERAL_CONVERSATION, context: { generatedReply: "To join a team, please type 'Join [Code]'." } };
    
    // Default fallback
    return { 
        intent: INTENTS.GENERAL_CONVERSATION, 
        context: { generatedReply: "I'm having trouble connecting to my brain right now. 🧠\nPlease use the menu to select an option, or try again in a moment." } 
    };
}

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
      },
      timeout: 8000 // [UPDATED] 8 Second Timeout to prevent server hanging
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
    throw error; // Rethrow to be caught by the caller's try/catch block
  }
}

// --- CORE INTENT & ENTITY EXTRACTION ---

export async function parseBulkProductList(text) {
    try {
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
    } catch (e) {
        logger.error("Error parsing bulk list:", e);
        return [];
    }
}

export async function extractOnboardingDetails(text) {
  try {
      const messages = [
        {
          role: 'system',
          content: "You are an expert entity extractor. Respond ONLY with a JSON object: {\"businessName\": \"Name\", \"email\": \"user@example.com\"}. If not found, use null."
        },
        { role: 'user', content: text }
      ];
      return await callDeepSeek(messages);
  } catch (e) {
      logger.error("Error extracting onboarding details:", e);
      return null;
  }
}

export async function extractCurrency(text) {
    try {
        const messages = [
            {
                role: 'system',
                content: "Identify the currency and return ISO 4217 code. JSON: {\"currency\": \"ISO_CODE\"}. Example: 'Naira' -> 'NGN'."
            },
            { role: 'user', content: text }
        ];
        return await callDeepSeek(messages);
    } catch (e) {
        return { currency: 'NGN' }; // Default fallback
    }
}

export async function getIntent(text) {
    // [UPDATED] Wrap in Try/Catch for Fallback
    try {
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
        - MANAGE_TEAM: "Add staff", "Invite employee", "Create login for my manager"
        - EXPORT_DATA: "Export my data", "Download excel", "Send me all records", "Backup"
        - CHECK_BANK_BALANCE: "Check my balance", "How much in Opay?", "Balance for GTB"

        RULES:
        1. If Intent is ${INTENTS.GENERATE_REPORT}:
           - Context MUST include "reportType": "SALES", "EXPENSES", "PNL", "INVENTORY", or "COGS".
           - **CRITICAL:** If user text is exactly "Generate Report" or "generate report", "reportType" MUST be null. Do NOT guess PNL.
           - Dates: Calculate "startDate" and "endDate" (YYYY-MM-DD). Default "this_month".
        
        2. Dates: Calculate "startDate" and "endDate" (YYYY-MM-DD) based on user input (e.g., "last month", "today"). Default to "this_month".

        3. General Conversation:
           - If the user says "Hello" or asks a question, set intent to ${INTENTS.GENERAL_CONVERSATION}.
           - You MUST provide a "generatedReply" string in the context.
        
        4. CHECK_BANK_BALANCE: Any query about "balance" or "how much in [Bank]" must be this intent.

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

    } catch (error) {
        logger.warn("AI Service Down/Slow. Using Fallback logic.", error.message);
        return getFallbackIntent(text);
    }
}

export async function getFinancialInsight(pnlData, currency) {
    try {
        const systemPrompt = `Analyze this P&L data and give one friendly, short business tip. Data: ${JSON.stringify(pnlData)}`;
        const messages = [{ role: 'system', content: systemPrompt }];
        return await callDeepSeek(messages, 0.7, false);
    } catch (e) {
        return "Great job tracking your finances! Regular records are the key to growth.";
    }
}

export async function gatherSaleDetails(conversationHistory, existingProduct = null, isService = false) { 
    try {
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
        4. If 'saleType' is CREDIT, listen for a due date (e.g., "pay next friday", "due 25th").
        5. If mentioned, calculate 'dueDate' as YYYY-MM-DD.
        6. Return JSON format:
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
    } catch (e) {
        return { status: "incomplete", reply: "I'm having trouble connecting to my brain right now. Please tell me the sale details again simpler.", memory: conversationHistory };
    }
}

// Supports Multiple Expenses
export async function gatherExpenseDetails(conversationHistory) {
    try {
        const systemPrompt = `You are a smart bookkeeping assistant. Goal: Log expense(s).
        INPUT: "Paid 5000 for fuel and 10000 for rent"
        
        RULES:
        1. Support MULTIPLE items.
        2. Auto-Categorize each.
        3. Ask clarifying questions if description is vague.
        4. Return JSON: {
            "status": "complete", 
            "data": { 
                "expenses": [ 
                    {"category": "Transportation", "amount": 5000, "description": "fuel"},
                    {"category": "Rent & Office", "amount": 10000, "description": "rent"}
                ] 
            }
        }
        5. If incomplete, return {"status": "incomplete", "reply": "..."}`;

        const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
        let response = await callDeepSeek(messages, 0.5);

        if (response.status === 'complete' && response.data) {
            if (!response.data.expenses) {
                response.data.expenses = [{
                    category: response.data.category,
                    amount: parsePrice(response.data.amount),
                    description: response.data.description
                }];
            } else {
                response.data.expenses = response.data.expenses.map(e => ({
                    ...e,
                    amount: parsePrice(e.amount)
                }));
            }
        }
        return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
    } catch (e) {
        return { status: "incomplete", reply: "I couldn't process that expense. Please try again.", memory: conversationHistory };
    }
}

export async function gatherProductDetails(conversationHistory, existingProduct = null) {
    try {
        const existingDataInfo = existingProduct 
            ? `Existing product: Cost ${existingProduct.costPrice}, Sell ${existingProduct.sellingPrice}.`
            : 'New product.';

        const systemPrompt = `Inventory Manager. Add/Update product.
        FIELDS: productName, quantityAdded, costPrice, sellingPrice, reorderLevel.
        CONTEXT: ${existingDataInfo}
        RULES:
        1. If user says "alert me at 10", set "reorderLevel": 10.
        2. Return JSON: {"status": "complete"/"incomplete", "data": {...}, "reply": "..."}`;

        const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
        let response = await callDeepSeek(messages, 0.5);

        if (response.status === 'complete' && response.data) {
             response.data.costPrice = parsePrice(response.data.costPrice);
             response.data.sellingPrice = parsePrice(response.data.sellingPrice);
             response.data.quantityAdded = parseInt(response.data.quantityAdded, 10);
             if (response.data.reorderLevel) response.data.reorderLevel = parseInt(response.data.reorderLevel, 10);
        }
        return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
    } catch (e) {
        return { status: "incomplete", reply: "System busy. Please try again.", memory: conversationHistory };
    }
}

export async function gatherPaymentDetails(conversationHistory, userCurrency) {
    try {
        const systemPrompt = `Log Customer Payment. Need: "customerName", "amount". Currency: ${userCurrency}.
        Return JSON: {"status": "complete"/"incomplete", "data": {"customerName": "...", "amount": "..."}, "reply": "Question to ask user..."}`;

        const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
        let response = await callDeepSeek(messages, 0.5);

        if (response.status === 'complete' && response.data) {
            response.data.amount = parsePrice(response.data.amount);
        }
        return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
    } catch (e) {
        return { status: "incomplete", reply: "System busy. Please try again.", memory: conversationHistory };
    }
}

export async function gatherBankAccountDetails(conversationHistory, userCurrency) {
    try {
        const systemPrompt = `Add Bank Account. Need: "bankName", "openingBalance". Currency: ${userCurrency}.
        Return JSON: {"status": "complete"/"incomplete", "data": {"bankName": "...", "openingBalance": "..."}, "reply": "Question to ask user..."}`;

        const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
        let response = await callDeepSeek(messages, 0.5);

        if (response.status === 'complete' && response.data) {
            response.data.openingBalance = parsePrice(response.data.openingBalance);
        }
        return { ...response, memory: [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }] };
    } catch (e) {
        return { status: "incomplete", reply: "System busy. Please try again.", memory: conversationHistory };
    }
}
