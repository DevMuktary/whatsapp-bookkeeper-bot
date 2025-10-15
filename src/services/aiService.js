import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { INTENTS } from '../utils/constants.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

async function callDeepSeek(messages, temperature = 0.1) {
  try {
    const response = await axios.post(DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: messages,
      temperature: temperature,
      response_format: { type: "json_object" }
    }, {
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
    const systemPrompt = `You are an advanced intent classification system for a bookkeeping app. You must respond ONLY with a JSON object.

The possible intents are:
- "${INTENTS.LOG_SALE}"
- "${INTENTS.LOG_EXPENSE}"
- "${INTENTS.ADD_PRODUCT}"
- "${INTENTS.ADD_MULTIPLE_PRODUCTS}"
- "${INTENTS.CHECK_STOCK}"
- "${INTENTS.GET_FINANCIAL_SUMMARY}"
- "${INTENTS.GENERATE_REPORT}"
- "${INTENTS.LOG_CUSTOMER_PAYMENT}"
- "${INTENTS.ADD_BANK_ACCOUNT}"
- "${INTENTS.CHECK_BANK_BALANCE}"
- "${INTENTS.RECONCILE_TRANSACTION}"

Your JSON response format is: {"intent": "INTENT_NAME", "context": {}}.

Extraction Rules:
1.  If the user says "I made a mistake", "delete a transaction", "edit a sale", "correct a record", or similar, the intent is "${INTENTS.RECONCILE_TRANSACTION}".
2.  For "${INTENTS.CHECK_BANK_BALANCE}", if a specific bank is named, extract {"bankName": "..."}.
3.  If the intent is not clear, respond with {"intent": null, "context": {}}.

Example:
User: "I need to correct my last entry"
Your Response: {"intent": "${INTENTS.RECONCILE_TRANSACTION}", "context": {}}
`;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    const responseJson = await callDeepSeek(messages);
    return JSON.parse(responseJson);
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

export async function gatherTransactionEdits(conversationHistory, originalTransaction) {
    let editableFieldsPrompt;
    switch (originalTransaction.type) {
        case 'SALE':
            editableFieldsPrompt = "The user can change 'unitsSold' (synonyms: unit, quantity, items) and 'amountPerUnit' (synonyms: price, cost). The total 'amount' is calculated automatically and CANNOT be edited directly. If the user tries to change the total amount, you must ask them to change the units sold or the price per unit instead.";
            break;
        case 'EXPENSE':
            editableFieldsPrompt = "The user can change 'amount', 'description', and 'category'.";
            break;
        case 'CUSTOMER_PAYMENT':
            editableFieldsPrompt = "The user can change the 'amount'.";
            break;
        default:
            editableFieldsPrompt = "The primary editable field is 'amount'.";
    }

    const systemPrompt = `You are an assistant helping a user edit a transaction. Your goal is to identify what fields they want to change and with what new values.

CONTEXT: The original transaction is: ${JSON.stringify(originalTransaction, null, 2)}
EDITING RULES: ${editableFieldsPrompt}

CONVERSATION FLOW:
1.  Analyze the user's message to see what they want to change. Be smart about synonyms (e.g., 'unit' means 'unitsSold').
2.  After identifying a valid change, confirm it and ask "Got it. Is there anything else you'd like to change?".
3.  If the user says "no", "that's all", or similar, your FINAL response must be a JSON object with {"status": "complete", "data": { ... an object of ONLY the changed fields ... }}.
4.  While you are still collecting changes, your response must be a JSON object with {"status": "incomplete", "reply": "Your confirmation and follow-up question."}.

Example for a SALE:
User: "change the unit to 3"
Your Response: {"status": "incomplete", "reply": "Okay, I've updated the units sold to 3. Anything else to change?"}
User: "no"
Your Response: {"status": "complete", "data": {"unitsSold": 3}}
`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.7);
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];

    return { ...response, memory: updatedHistory };
}
