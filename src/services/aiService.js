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
    const systemPrompt = `You are an advanced intent classification and entity extraction system for a bookkeeping app. You must respond ONLY with a JSON object.

The possible intents are:
- "${INTENTS.LOG_SALE}"
- "${INTENTS.LOG_EXPENSE}"
- "${INTENTS.ADD_PRODUCT}" (for a single product)
- "${INTENTS.ADD_MULTIPLE_PRODUCTS}" (if two or more products are mentioned)
- "${INTENTS.CHECK_STOCK}"
- "${INTENTS.GET_FINANCIAL_SUMMARY}"
- "${INTENTS.GENERATE_REPORT}"

Your JSON response format is: {"intent": "INTENT_NAME", "context": { ... extracted details ... }}.

Extraction Rules:
1.  For "${INTENTS.CHECK_STOCK}", context must contain {"productName": "..."}.
2.  For "${INTENTS.GET_FINANCIAL_SUMMARY}", context must contain {"metric": "...", "period": "..."}. 'metric' is "sales" or "expenses". 'period' is one of ["today", "this_week", "this_month", "last_month"].
3.  For "${INTENTS.GENERATE_REPORT}", context must contain {"reportType": "...", "period": "..."}. 'reportType' is "sales", "expenses", or "inventory". 'period' is one of ["today", "this_week", "this_month", "last_month"].
4.  For "${INTENTS.ADD_MULTIPLE_PRODUCTS}", context MUST contain a key "products" which is an ARRAY of product objects.
5.  If the user's message is ambiguous, conversational, or does not match any intent, respond with {"intent": null, "context": {}}.

Example 1:
User: "send my sales report for this month"
Your Response: {"intent": "${INTENTS.GENERATE_REPORT}", "context": {"reportType": "sales", "period": "this_month"}}

Example 2:
User: "what are my total sales for this month"
Your Response: {"intent": "${INTENTS.GET_FINANCIAL_SUMMARY}", "context": {"metric": "sales", "period": "this_month"}}
`;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    const responseJson = await callDeepSeek(messages);
    return JSON.parse(responseJson);
}

export async function gatherSaleDetails(conversationHistory) {
    const systemPrompt = `You are a friendly and efficient bookkeeping assistant named Fynax. Your current goal is to collect all the necessary details to log a sale.
You must fill a JSON object with these exact keys: "productName", "unitsSold", "amountPerUnit", "customerName", "saleType". The 'saleType' must be one of ['cash', 'credit', 'bank'].

CONVERSATION RULES:
1.  Analyze the conversation history provided by the user.
2.  If any of the required keys are missing, ask a clear, friendly question to get ONLY the missing information. Do NOT ask for multiple things at once.
3.  Be conversational. For example, if a user provides a product name, acknowledge it before asking the next question.
4.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final sale object ... }}.
5.  While you are still collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question or comment to the user."}.
`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5); 
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];
    
    return { ...response, memory: updatedHistory };
}

export async function gatherExpenseDetails(conversationHistory) {
    const systemPrompt = `You are a friendly and efficient bookkeeping assistant named Fynax. Your current goal is to collect all the necessary details to log an expense.
You must fill a JSON object with these exact keys: "category", "amount", "description". The 'description' should be a brief summary of the expense.

CONVERSATION RULES:
1.  Analyze the conversation history.
2.  If any required keys are missing, ask a clear, friendly question for the missing information.
3.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final expense object ... }}.
4.  While collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question to the user."}.
`;

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

    const systemPrompt = `You are a friendly and efficient inventory manager named Fynax. Your goal is to collect details to add or update a product.
You must fill a JSON object with these exact keys: "productName", "quantityAdded", "costPrice", "sellingPrice".

CONTEXT: ${existingDataInfo}

CONVERSATION RULES:
1.  Analyze the conversation history.
2.  If the user says the price is the "same as before", "unchanged", or similar, YOU MUST use the existing product data for the price.
3.  Only ask for information that is truly missing. For example, if you already have the productName and quantityAdded, your next question should be about the costPrice.
4.  If all required information is already present in the conversation, immediately proceed to the 'complete' status.
5.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final product object ... }}.
6.  While collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question to the user."}.
`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];

    return { ...response, memory: updatedHistory };
}
