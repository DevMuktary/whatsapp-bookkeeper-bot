import { callDeepSeek } from './providers.js';
import logger from '../utils/logger.js';
import { INTENTS } from '../utils/constants.js';

// --- HELPERS ---
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

function getFallbackIntent(text) {
    const t = text.toLowerCase();
    
    // Strict Keywords to prevent Hallucinations
    if (t.includes('add bank') || t.includes('new bank')) return { intent: INTENTS.ADD_BANK_ACCOUNT, context: {} };
    if (t.includes('pay') && t.includes('subscription')) return { intent: INTENTS.UPGRADE_SUBSCRIPTION, context: {} };
    if (t.includes('renew') || t.includes('upgrade plan') || t.includes('buy premium')) return { intent: INTENTS.UPGRADE_SUBSCRIPTION, context: {} };
    if (t.includes('subscription') || t.includes('my plan')) return { intent: INTENTS.CHECK_SUBSCRIPTION, context: {} };
    if (t.includes('insight') || t.includes('tip') || t.includes('advice')) return { intent: INTENTS.GET_FINANCIAL_INSIGHT, context: {} };
    if (t.includes('sold') || t.includes('sale') || t.includes('sell')) return { intent: INTENTS.LOG_SALE, context: {} };
    
    if (t.includes('paid debt') || t.includes('paid credit') || (t.includes('paid') && t.includes('owe')) || t.includes('customer payment')) {
        return { intent: INTENTS.LOG_CUSTOMER_PAYMENT, context: {} };
    }

    if (t.includes('bought') || t.includes('expense') || t.includes('spent') || t.includes('paid')) return { intent: INTENTS.LOG_EXPENSE, context: {} };
    if (t.includes('stock') || t.includes('inventory') || t.includes('count')) return { intent: INTENTS.CHECK_STOCK, context: {} };
    if (t.includes('menu') || t.includes('start') || t.includes('hi') || t.includes('options')) return { intent: INTENTS.SHOW_MAIN_MENU, context: {} };
    if (t.includes('balance') || t.includes('how much in')) return { intent: INTENTS.CHECK_BANK_BALANCE, context: {} };
    
    // Broader fallback for debt checking
    if (t.includes('owe') || t.includes('debt') || t.includes('customer balance') || t.includes('who is owing')) return { intent: INTENTS.GET_CUSTOMER_BALANCES, context: {} };
    
    if (t.includes('report') || t.includes('pdf') || t.includes('p&l') || t.includes('statement')) return { intent: INTENTS.GENERATE_REPORT, context: {} };
    if (t.includes('join')) return { intent: INTENTS.GENERAL_CONVERSATION, context: { generatedReply: "To join a team, please type 'Join [Code]'." } };

    if (t.includes('edit') || t.includes('delete') || t.includes('correct') || t.includes('change') || t.includes('modify')) {
        return { intent: INTENTS.RECONCILE_TRANSACTION, context: {} };
    }
    
    return { 
        intent: INTENTS.GENERAL_CONVERSATION, 
        context: { generatedReply: "I'm having trouble connecting to my brain right now. 🧠\nPlease use the menu to select an option." } 
    };
}

// --- EXPORTED LOGIC ---

export async function getIntent(text) {
    const t = text.toLowerCase().trim();

    // 1. FAST PATH (Priority Over AI)
    if (t.includes('add bank') || t.includes('add new bank') || t === 'add account') {
        return { intent: INTENTS.ADD_BANK_ACCOUNT, context: {} };
    }

    if (t.startsWith('!') || t.startsWith('/')) {
        return { intent: INTENTS.GENERAL_CONVERSATION, context: { generatedReply: "If that was a command, I didn't recognize it. Try checking the menu." } };
    }

    if (['menu', 'options', 'home', 'start', 'cancel', 'stop', 'exit'].includes(t)) {
        return { intent: INTENTS.SHOW_MAIN_MENU, context: {} };
    }
    if (t === 'hi' || t === 'hello' || t === 'hey') {
         return { intent: INTENTS.GENERAL_CONVERSATION, context: { generatedReply: "Hello! How can I help you today?" } };
    }
    if ((t.includes('pay') || t.includes('renew')) && (t.includes('subscription') || t.includes('fynax'))) {
        return { intent: INTENTS.UPGRADE_SUBSCRIPTION, context: {} };
    }
    if (t.includes('balance') && t.length < 20) {
        return { intent: INTENTS.CHECK_BANK_BALANCE, context: {} };
    }
    if (t.includes('subscription') || t === 'my plan' || t === 'check status') {
        return { intent: INTENTS.CHECK_SUBSCRIPTION, context: {} };
    }

    if (t === 'generate sales report') return { intent: INTENTS.GENERATE_REPORT, context: { reportType: 'SALES' } };
    if (t === 'generate expense report') return { intent: INTENTS.GENERATE_REPORT, context: { reportType: 'EXPENSES' } };
    if (t === 'generate p&l report') return { intent: INTENTS.GENERATE_REPORT, context: { reportType: 'PNL' } };
    if (t === 'generate cogs report') return { intent: INTENTS.GENERATE_REPORT, context: { reportType: 'COGS' } };
    if (t === 'generate inventory report') return { intent: INTENTS.GENERATE_REPORT, context: { reportType: 'INVENTORY' } };

    const editKeywords = ['edit', 'delete', 'correct', 'change', 'remove', 'mistake', 'undo'];
    if (editKeywords.some(keyword => t.includes(keyword))) {
        return { intent: INTENTS.RECONCILE_TRANSACTION, context: {} };
    }
    if (t.includes('add product') || t.includes('restock')) return { intent: INTENTS.ADD_PRODUCT, context: {} };

    // 2. AI PATH
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const systemPrompt = `You are an intent classifier. Respond ONLY with JSON.
        TODAY: ${today}

        INTENTS:
        - ${INTENTS.LOG_SALE}: "Sold 5 rice", "Credit sale to John"
        - ${INTENTS.LOG_EXPENSE}: "Bought fuel 500", "Paid shop rent"
        - ${INTENTS.LOG_CUSTOMER_PAYMENT}: "John paid his debt", "Received 5000 from Mary for her balance", "Customer payment".
        - ${INTENTS.ADD_PRODUCT}: "Restock rice", "New item indomie"
        - ${INTENTS.ADD_BANK_ACCOUNT}: "Add bank", "Add new bank", "New account".
        - ${INTENTS.GENERATE_REPORT}: "Send me a PDF", "Sales report", "P&L", "Profit and Loss".
        - ${INTENTS.GET_FINANCIAL_INSIGHT}: "Get financial insight", "Give me a business tip".
        - ${INTENTS.GET_FINANCIAL_SUMMARY}: "Total sales today", "How much did I spend?"
        - ${INTENTS.CHECK_BANK_BALANCE}: "Check my balance", "How much in Opay?"
        - ${INTENTS.GET_CUSTOMER_BALANCES}: "Who owes me?", "How much does John owe me?", "Customer balances", "Are people owing me?".
        - ${INTENTS.GENERAL_CONVERSATION}: "Hello", "Thanks", "Hi".
        - ${INTENTS.CHECK_SUBSCRIPTION}: "My plan", "When do I expire?".
        - ${INTENTS.UPGRADE_SUBSCRIPTION}: "Renew Fynax", "Upgrade to premium".
        - ${INTENTS.RECONCILE_TRANSACTION}: "Edit last sale", "Delete transaction".

        CRITICAL RULES:
        1. "Add Bank" or "Add New Bank" = ${INTENTS.ADD_BANK_ACCOUNT}.
        2. "Pay for Subscription" = ${INTENTS.UPGRADE_SUBSCRIPTION}.
        3. "Generate Report" = ${INTENTS.GENERATE_REPORT}. Context MUST include "reportType" (SALES, EXPENSES, PNL, INVENTORY, COGS) if specified.
        4. "Edit" or "Delete" or "Correction" = ${INTENTS.RECONCILE_TRANSACTION}.
        
        5. **CUSTOMER DEBTS**: If the user asks about a SPECIFIC person's debt (e.g., "How much does Mary owe"), you MUST include "customerName": "Mary" in the context. If asking generally, don't include customerName.
        
        6. **DATE INTELLIGENCE**:
           - Calculate Start Date and End Date.
           - **ALWAYS** return specific "startDate" and "endDate" in "YYYY-MM-DD" format.
           - If no date is specified, do NOT add startDate/endDate keys.
        
        Return JSON format: {"intent": "...", "context": {"customerName": "...", "reportType": "...", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD"}}
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

    } catch (error) {
        logger.warn("AI Service Error. Using Fallback logic.");
        return getFallbackIntent(text);
    }
}

export async function getFinancialInsight(pnlData, currency) {
    try {
        const systemPrompt = `You are a financial advisor. Analyze this P&L data and give ONE short, friendly, actionable business tip (max 2 sentences). Data: ${JSON.stringify(pnlData)}`;
        const messages = [{ role: 'system', content: systemPrompt }];
        return await callDeepSeek(messages, 0.7, false);
    } catch (e) {
        return "Great job tracking your finances! Consistent records are the key to growing your business.";
    }
}

export async function extractOnboardingDetails(text) {
  try {
      const messages = [{ role: 'system', content: "Extract JSON: {\"businessName\", \"email\"}" }, { role: 'user', content: text }];
      return await callDeepSeek(messages);
  } catch (e) {
      logger.error("Error extracting onboarding details:", e);
      return null;
  }
}

export async function extractCurrency(text) {
    try {
        const messages = [{ role: 'system', content: "Extract JSON: {\"currency\": \"ISO_CODE\"}" }, { role: 'user', content: text }];
        return await callDeepSeek(messages);
    } catch (e) {
        return { currency: 'NGN' }; 
    }
}

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

export async function gatherSaleDetails(conversationHistory, existingProduct = null, isService = false) { 
    try {
        const today = new Date().toISOString().split('T')[0];
        const productInfo = isService 
            ? "The user confirmed this is a service." 
            : (existingProduct ? `Existing product: "${existingProduct.productName}", Price: ${existingProduct.sellingPrice}.` : 'New product/service.');

        // [FIX] Strictly forbid the AI from asking for Customer Name or Payment Method
        const systemPrompt = `You are a bookkeeping assistant logging a sale. TODAY: ${today}.
        CONTEXT: ${productInfo}
        GOAL: Collect 'items' (array of {productName, quantity, pricePerUnit}). Also extract 'customerName' and 'saleType' ONLY IF the user explicitly mentioned them.
        
        CRITICAL RULES (NO GUESSING):
        1. Extract items and prices. Default quantity is 1.
        2. If product exists, use its price. If NOT, and user didn't specify price, return status 'incomplete' and ask for price ONLY.
        3. AMBIGUOUS PRICE: If the user provides a quantity > 1 and a price (e.g., "3 bread for 600"), and it is unclear if 600 is the total or per unit, you MUST return status 'incomplete' and ask: "Did you mean 600 per unit, or 600 in total?".
        4. NEVER ask for the customer name. If the user didn't mention it, just leave "customerName" empty.
        5. NEVER ask for the payment method (Cash/Bank/Credit). If it is missing, just leave "saleType" empty.
        6. If items and prices are successfully resolved, return status "complete" even if customerName or saleType are empty. The system will handle asking for them later.
        7. Return JSON format:
        {"status": "complete"/"incomplete", "data": {"items": [], "customerName": "...", "saleType": "..."}, "reply": "Question to user..."}`;

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
    } catch (e) {
        return { status: "incomplete", reply: "I'm having trouble connecting to my brain right now. Please tell me the sale details again simpler.", memory: conversationHistory };
    }
}

export async function gatherExpenseDetails(conversationHistory) {
    try {
        const systemPrompt = `You are a smart bookkeeping assistant. Goal: Log expense(s).
        INPUT: "Paid 5000 for fuel and 10000 for rent"
        
        CRITICAL RULES (NO GUESSING):
        1. If 'amount' is missing, return status 'incomplete' and ask "How much was the expense?".
        2. If 'description' is too vague (e.g., "I spent money"), ask "What was the money for?".
        3. Auto-Categorize if details are sufficient.
        4. Return JSON: { "status": "complete", "data": { "expenses": [...] } } OR { "status": "incomplete", "reply": "..." }`;

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
        
        CRITICAL RULES (NO GUESSING):
        1. For a NEW product, you MUST have: 'productName', 'costPrice', and 'sellingPrice'. 
        2. If 'costPrice' is missing, return status 'incomplete' and ask "What is the Cost Price?".
        3. If 'sellingPrice' is missing, return status 'incomplete' and ask "What is the Selling Price?".
        4. If 'quantity' is missing, ask "How many are you adding?".
        5. Return JSON: {"status": "complete"/"incomplete", "data": {...}, "reply": "..."}`;

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
        CRITICAL RULES:
        1. If 'customerName' is missing, ask "Who made the payment?".
        2. If 'amount' is missing, ask "How much did they pay?".
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
        CRITICAL RULES:
        1. If 'bankName' is missing, ask "What is the bank name?".
        2. If 'openingBalance' is missing, ask "What is the current balance?".
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
