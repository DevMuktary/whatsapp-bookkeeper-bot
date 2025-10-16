import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { INTENTS } from '../utils/constants.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

async function callDeepSeek(messages, temperature = 0.1, enforceJson = true) {
  try {
    const payload = {
      model: 'deepseek-chat',
      messages: messages,
      temperature: temperature,
    };
    if (enforceJson) {
        payload.response_format = { type: "json_object" };
    }

    const response = await axios.post(DEEPSEEK_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseek.apiKey}`
      }
    });
    return response.data.choices[0].message.content;
  } catch (error) {
    logger.error('Error calling DeepSeek API:', error.response ? error.response.data : error.message);
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
  return JSON.parse(responseJson);
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
    return JSON.parse(responseJson);
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
    - User: "ok" -> {"intent": "${INTENTS.CHITCHAT}", "context": {}}
    - User: "thanks!" -> {"intent": "${INTENTS.CHITCHAT}", "context": {}}
    - User: "ok, log a sale" -> {"intent": "${INTENTS.LOG_SALE}", "context": {}} (This is NOT chitchat)

2.  **Main Menu:** If the user asks for the "menu", "main menu", "show options", "show menu", the intent is "${INTENTS.SHOW_MAIN_MENU}".

3.  **List Input:** If the user's message is a multi-line list starting with numbers, the intent is ALWAYS "${INTENTS.ADD_PRODUCTS_FROM_LIST}".

4.  **Reconciliation:** If the user says "I made a mistake", "delete transaction", "edit a sale", "correct a record", "edit transaction", the intent is "${INTENTS.RECONCILE_TRANSACTION}".

5.  **Customer Balances:** If the user asks "who is owing me?", "customer balance", "who owes me", "show debtors", the intent is "${INTENTS.GET_CUSTOMER_BALANCES}".

6.  **Reports:** For "${INTENTS.GENERATE_REPORT}", extract "reportType" and "period". Be flexible. 'reportType' can be "sales", "expenses", "inventory", or "pnl", "profit and loss", "profit & loss".
    - User: "my p&l report" -> {"intent": "${INTENTS.GENERATE_REPORT}", "context": {"reportType": "pnl"}}
    - User: "generate profit and loss report" -> {"intent": "${INTENTS.GENERATE_REPORT}", "context": {"reportType": "pnl"}}
    - User: "sales report for this month" -> {"intent": "${INTENTS.GENERATE_REPORT}", "context": {"reportType": "sales", "period": "this_month"}}

7.  If a clear bookkeeping intent is present, prioritize it. If no bookkeeping intent is clear, and it's not chitchat or menu, respond with {"intent": null, "context": {}}.
`;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    const responseJson = await callDeepSeek(messages);
    return JSON.parse(responseJson);
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
    const insight = await callDeepSeek(messages, 0.7, false); 
    return insight;
}

export async function gatherSaleDetails(conversationHistory, existingProduct = null) {
    const existingDataInfo = existingProduct 
        ? `The user is selling an existing product called "${existingProduct.productName}". Its default selling price is ${existingProduct.sellingPrice}.`
        : 'The user is selling a new product or the product was not found in the inventory.';

    const systemPrompt = `You are a friendly and efficient bookkeeping assistant named Fynax. Your current goal is to collect all the necessary details to log a sale.
You must fill a JSON object with these exact keys: "productName", "unitsSold", "amountPerUnit", "customerName", "saleType". The 'saleType' must be one of ['cash', 'credit', 'bank'].

CONTEXT: ${existingDataInfo}

CONVERSATION RULES:
1.  Analyze the conversation history.
2.  If the 'amountPerUnit' is missing but an existing product price is available, YOU MUST use the existing selling price. Do not ask for the price.
3.  Only ask for information that is truly missing.
4.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final sale object ... }}.
5.  While collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question or comment to the user."}.
`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5); 
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];
    
    return { ...response, memory: updatedHistory };
}

export async function gatherExpenseDetails(conversationHistory) {
    const systemPrompt = `You are a friendly and efficient bookkeeping assistant named Fynax. Your goal is to collect details to log an expense. You must fill a JSON object with these exact keys: "category", "amount", "description".

CONVERSATION RULES:
1.  Analyze the conversation history. If any keys are missing, ask a clear, friendly question for the missing information.
2.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final expense object ... }}.
3.  While collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question to the user."}.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];

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
5.  While collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question to the user."}.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];

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
5.  While collecting information, your response must be a JSON object with {"status": "incomplete", "reply": "Your question to the user."}.
`;
    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];

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
5.  While collecting information, your response must be a JSON object with {"status": "incomplete", "reply": "Your question to the user."}.
`;
    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];

    return { ...response, memory: updatedHistory };
}
