import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { INTENTS } from '../utils/constants.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * Parses a price string (e.g., "₦1,000", "2.5m", "50k", "10000") into a number.
 * @param {string|number} priceInput The string or number to parse.
 * @returns {number} The parsed numeric value, or NaN if invalid.
 */
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
    const lastMessageContent = messages[messages.length - 1].content.toLowerCase();
    if (enforceJson && messages.some(m => m.role === 'system' && m.content.toLowerCase().includes('json'))) {
        payload.response_format = { type: "json_object" };
    }


    const response = await axios.post(DEEPSEEK_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseek.apiKey}`
      }
    });
    // Check if the expected response was JSON but we didn't get it (due to prompt issues)
     if (enforceJson && payload.response_format && typeof response.data.choices[0].message.content !== 'string') {
        // This case should ideally not happen if prompt is correct, but as a fallback:
        return JSON.stringify(response.data.choices[0].message.content);
     }
     // If the response *is* a string but looks like JSON, parse it
     if (typeof response.data.choices[0].message.content === 'string' && response.data.choices[0].message.content.trim().startsWith('{')) {
         try {
             // Attempt to parse, but handle potential errors if it's not valid JSON
             return JSON.parse(response.data.choices[0].message.content);
         } catch (parseError) {
             logger.warn("AI response looked like JSON but failed to parse:", response.data.choices[0].message.content);
             // Fallback to returning the raw string if parsing fails
             return response.data.choices[0].message.content;
         }
     }

    // Otherwise, return the content as is (likely for non-JSON requests like insights)
    return response.data.choices[0].message.content;

  } catch (error) {
    // Log the detailed error from the API if available
    logger.error('Error calling DeepSeek API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    throw new Error('Failed to communicate with the AI service.');
  }
}

export async function extractOnboardingDetails(text) {
  const messages = [
    {
      role: 'system',
      content: "You are an expert entity extractor. Your task is to extract a business name and an email address from the user's message. Respond ONLY with a JSON object in the format {\"businessName\": \"The Extracted Name\", \"email\": \"user@example.com\"}. If a piece of information is not found, its value should be null."
    },
    {
      role: 'user',
      content: `Here is the message: "${text}"`
    }
  ];
  const responseJson = await callDeepSeek(messages);
  // Ensure response is parsed JSON
  return typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
}

export async function extractCurrency(text) {
    const messages = [
        {
            role: 'system',
            content: "You are an expert currency identification system. Your task is to identify the currency mentioned in the user's text and convert it to its standard 3-letter ISO 4217 code. Examples: 'Naira' or '₦' -> 'NGN', 'US dollars' or '$' -> 'USD', 'Ghana Cedis' -> 'GHS', 'pounds' -> 'GBP'. Respond ONLY with a JSON object in the format {\"currency\": \"ISO_CODE\"}. If no currency is found, the value should be null."
        },
        {
            role: 'user',
            content: `Here is the message: "${text}"`
        }
    ];
    const responseJson = await callDeepSeek(messages);
    return typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
}

export async function getIntent(text) {
    const systemPrompt = `You are an advanced intent classification system. Respond ONLY with a JSON object.

The possible intents are:
- "${INTENTS.LOG_SALE}"
- "${INTENTS.LOG_EXPENSE}"
- "${INTENTS.ADD_PRODUCT}"
- "${INTENTS.ADD_PRODUCTS_FROM_LIST}"
- "${INTENTS.CHECK_STOCK}"
- "${INTENTS.GET_FINANCIAL_SUMMARY}"
- "${INTENTS.GENERATE_REPORT}"
- "${INTENTS.LOG_CUSTOMER_PAYMENT}"
- "${INTENTS.ADD_BANK_ACCOUNT}"
- "${INTENTS.CHECK_BANK_BALANCE}"
- "${INTENTS.RECONCILE_TRANSACTION}"
- "${INTENTS.GET_FINANCIAL_INSIGHT}"
- "${INTENTS.GET_CUSTOMER_BALANCES}"
- "${INTENTS.SHOW_MAIN_MENU}"
- "${INTENTS.CHITCHAT}"

Your JSON response format is: {"intent": "INTENT_NAME", "context": {}}.

Extraction Rules & Examples:
1.  **Chitchat:** If the message is a simple greeting, acknowledgement, or compliment like "hi", "ok", "good", "alright", "thank you", "thanks", "lol", and it contains NO bookkeeping request, the intent is "${INTENTS.CHITCHAT}".
2.  **Main Menu:** If the user asks for the "menu", "main menu", "show options", "show menu", the intent is "${INTENTS.SHOW_MAIN_MENU}".
3.  **List Input:** If the user's message is a multi-line list starting with numbers, the intent is ALWAYS "${INTENTS.ADD_PRODUCTS_FROM_LIST}".
4.  **Reconciliation:** If the user says "I made a mistake", "delete transaction", "edit a sale", "correct a record", "edit transaction", the intent is "${INTENTS.RECONCILE_TRANSACTION}".
5.  **Customer Balances:** If the user asks "who is owing me?", "customer balance", "who owes me", "show debtors", the intent is "${INTENTS.GET_CUSTOMER_BALANCES}".
6.  **Reports:** For "${INTENTS.GENERATE_REPORT}", extract "reportType" and "period". Be flexible. 'reportType' can be "sales", "expenses", "inventory", or "pnl", "profit and loss", "profit & loss".
7.  **Sales:** Extract item name, quantity, price per unit (if specified), customer name, sale type (cash/credit/bank). Quantity defaults to 1 if not mentioned. If price per unit is missing, the context should reflect that.
8.  If a clear bookkeeping intent is present, prioritize it. If no intent is clear, respond with {"intent": null, "context": {}}. You MUST respond ONLY with a JSON object.
`;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    const responseJson = await callDeepSeek(messages);
    let result = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;

    // Post-processing to clean up extracted numbers
    if (result.intent === INTENTS.LOG_SALE && result.context) {
        if (result.context.amountPerUnit) {
            result.context.amountPerUnit = parsePrice(result.context.amountPerUnit);
        }
        if (result.context.totalAmount) {
             result.context.totalAmount = parsePrice(result.context.totalAmount);
             if (!result.context.amountPerUnit && result.context.unitsSold && result.context.totalAmount) {
                 result.context.amountPerUnit = result.context.totalAmount / result.context.unitsSold;
             }
        }
        if (!result.context.unitsSold) {
            result.context.unitsSold = 1; 
        }
    }
     if (result.intent === INTENTS.LOG_EXPENSE && result.context && result.context.amount) {
         result.context.amount = parsePrice(result.context.amount);
     }
     if (result.intent === INTENTS.LOG_CUSTOMER_PAYMENT && result.context && result.context.amount) {
         result.context.amount = parsePrice(result.context.amount);
     }
      if (result.intent === INTENTS.ADD_BANK_ACCOUNT && result.context && result.context.openingBalance) {
         result.context.openingBalance = parsePrice(result.context.openingBalance);
     }

    return result;
}

export async function getFinancialInsight(pnlData, currency) {
    const { totalSales, totalCogs, grossProfit, totalExpenses, netProfit, topExpenses } = pnlData;
    const format = (amount) => new Intl.NumberFormat('en-US').format(amount);

    const systemPrompt = `You are Fynax, a friendly and encouraging financial advisor for small business owners in Nigeria. Your goal is to provide ONE clear, simple, and actionable insight based on the financial data provided. Speak in plain, encouraging language. Avoid jargon. Start your response with a friendly greeting. Your entire response must be a single paragraph.

Data for this period:
- Total Sales (Revenue): ${currency} ${format(totalSales)}
- Cost of Goods Sold (COGS): ${currency} ${format(totalCogs)}
- Gross Profit: ${currency} ${format(grossProfit)}
- Total Expenses: ${currency} ${format(totalExpenses)}
- **Net Profit:** ${currency} ${format(netProfit)}
- Top 3 Expenses: ${topExpenses.map(e => `${e._id}: ${currency} ${format(e.total)}`).join(', ')}

Analyze this data and provide ONE insight. Here are some patterns to look for:
- If Net Profit is positive: Start by congratulating them.
- If Net Profit is negative: Be encouraging. Say something like "Building a business takes time."
- If COGS is very high compared to Sales: Suggest they might want to look at their supplier costs or pricing strategy for their products.
- If one specific expense category is much higher than others: Gently point it out and suggest it's an area to watch.
- If sales are good but net profit is low due to high expenses: Commend their sales effort and suggest reviewing operational costs.
- If there is no data: Just say you need more data to provide an insight.
`;

    const messages = [{ role: 'system', content: systemPrompt }];
    // This call does NOT enforce JSON, so it's fine.
    const insight = await callDeepSeek(messages, 0.7, false); 
    return insight;
}

export async function gatherSaleDetails(conversationHistory, existingProduct = null, isService = false) {
    const productInfo = isService 
        ? "The user confirmed this is a service, not a product from inventory." 
        : (existingProduct 
            ? `This sale involves an existing product: "${existingProduct.productName}". Its default selling price is ${existingProduct.sellingPrice}.`
            : 'This might be a new product or a service.');

    const systemPrompt = `You are a friendly bookkeeping assistant (Fynax) logging a sale. Your goal is to collect sale details. 
You MUST track items being sold in an 'items' array. Each item MUST have 'productName', 'quantity', and 'pricePerUnit'.

CONTEXT: ${productInfo}

CONVERSATION RULES:
1.  **Item Details:** From the user's messages, extract 'productName', 'quantity' (default 1), and 'pricePerUnit'. If 'pricePerUnit' is missing and an existing product price is available, use it. If it's a service, ask for the total price/amount directly.
2.  **Required Info:** You also need 'customerName' and 'saleType' (cash, credit, bank). Ask for these if missing.
3.  **Add Item:** Once you have productName, quantity, and pricePerUnit for an item, add it to an 'items' array in your internal memory.
4.  **Ask for More Items:** After adding an item, ALWAYS ask clearly: "Okay, added [Item Name]. Anything else to add to this sale?".
5.  **Completion:** ONLY when the user says "no", "done", "that's all", AND you have the 'customerName' and 'saleType', respond with {"status": "complete", "data": {"items": [...], "customerName": "...", "saleType": "..."}}.
6.  **In Progress:** While gathering info or items, respond with {"status": "incomplete", "reply": "Your question..."}.

You MUST respond ONLY with a JSON object in the specified formats.
`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5); 
    let response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
    
    if (response.status === 'complete' && response.data && response.data.items) {
        response.data.items = response.data.items.map(item => ({
            ...item,
            pricePerUnit: parsePrice(item.pricePerUnit),
            quantity: item.quantity ? parseInt(item.quantity, 10) : 1
        }));
    }

    const updatedHistory = [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }]; // Store the JSON string in history
    
    return { ...response, memory: updatedHistory };
}

export async function gatherExpenseDetails(conversationHistory) {
    const systemPrompt = `You are a friendly and efficient bookkeeping assistant named Fynax. Your goal is to collect details to log an expense. You must fill a JSON object with these exact keys: "category", "amount", "description".

CONVERSATION RULES:
1.  Analyze the conversation history. If any keys are missing, ask a clear, friendly question for the missing information.
2.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final expense object ... }}.
3.  While collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question to the user."}. You MUST respond ONLY with a JSON object.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    let response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;

    if (response.status === 'complete' && response.data && response.data.amount) {
        response.data.amount = parsePrice(response.data.amount);
    }

    const updatedHistory = [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }];
    return { ...response, memory: updatedHistory };
}

export async function gatherProductDetails(conversationHistory, existingProduct = null) {
    const existingDataInfo = existingProduct 
        ? `This is an existing product. Its current cost price is ${existingProduct.costPrice} and selling price is ${existingProduct.sellingPrice}.`
        : 'This is a brand new product.';

    const systemPrompt = `You are a friendly inventory manager named Fynax. Your goal is to collect details to add or update a product. You must fill a JSON object with keys: "productName", "quantityAdded", "costPrice", "sellingPrice".

CONTEXT: ${existingDataInfo}

CONVERSATION RULES:
1.  Analyze the conversation history.
2.  If the user says the price is the "same as before", you MUST use the existing product data.
3.  Only ask for information that is truly missing.
4.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final product object ... }}.
5.  While collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question to the user."}. You MUST respond ONLY with a JSON object.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    let response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;

     if (response.status === 'complete' && response.data) {
         response.data.costPrice = parsePrice(response.data.costPrice);
         response.data.sellingPrice = parsePrice(response.data.sellingPrice);
         response.data.quantityAdded = parseInt(response.data.quantityAdded, 10);
     }

    const updatedHistory = [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }];
    return { ...response, memory: updatedHistory };
}

export async function gatherPaymentDetails(conversationHistory, userCurrency) {
    const systemPrompt = `You are a friendly and efficient bookkeeping assistant. Your goal is to log a payment received from a customer.
You must fill a JSON object with these exact keys: "customerName", "amount".

CONTEXT: The user's default currency is ${userCurrency}.

CONVERSATION RULES:
1.  You MUST assume all monetary values are in the user's default currency (${userCurrency}).
2.  DO NOT ask the user to specify or confirm the currency.
3.  If any required keys are missing, ask a clear question for the missing information.
4.  Once ALL keys are filled, your FINAL response must be a JSON object with {"status": "complete", "data": {"customerName": "...", "amount": ...}}.
5.  While collecting information, your response must be a JSON object with {"status": "incomplete", "reply": "Your question to the user."}. You MUST respond ONLY with a JSON object.
`;
    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    let response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;

    if (response.status === 'complete' && response.data && response.data.amount) {
        response.data.amount = parsePrice(response.data.amount);
    }

    const updatedHistory = [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }];
    return { ...response, memory: updatedHistory };
}

export async function gatherBankAccountDetails(conversationHistory, userCurrency) {
    const systemPrompt = `You are a friendly assistant helping a user set up a new bank account in their books.
You must fill a JSON object with these exact keys: "bankName", "openingBalance".

CONTEXT: The user's default currency is ${userCurrency}.

CONVERSATION RULES:
1.  You MUST assume the openingBalance is in the user's default currency (${userCurrency}).
2.  DO NOT ask for the currency.
3.  If any required keys are missing, ask a clear question for the missing information.
4.  Once ALL keys are filled, your FINAL response must be a JSON object with {"status": "complete", "data": {"bankName": "...", "openingBalance": ...}}.
5.  While collecting information, your response must be a JSON object with {"status": "incomplete", "reply": "Your question to the user."}. You MUST respond ONLY with a JSON object.
`;
    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    let response = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;

    if (response.status === 'complete' && response.data && response.data.openingBalance) {
        response.data.openingBalance = parsePrice(response.data.openingBalance);
    }

    const updatedHistory = [...conversationHistory, { role: 'assistant', content: JSON.stringify(response) }];
    return { ...response, memory: updatedHistory };
}
