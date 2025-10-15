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
    const messages = [
        {
            role: 'system',
            content: `You are an intent classification system for a bookkeeping app. Your job is to analyze the user's message and determine their intent. You must respond ONLY with a JSON object. The possible intents are [\"${INTENTS.LOG_SALE}\", \"${INTENTS.LOG_EXPENSE}\"]. If an intent is detected, also extract any available details. The JSON format is {"intent": "INTENT_NAME", "context": { ... extracted details ... }}. Example contexts are {"productName": "...", "unitsSold": ..., "amountPerUnit": ...} for LOG_SALE, and {"amount": ..., "expenseType": "...", "description": "..."} for LOG_EXPENSE. If the user's message is conversational or does not match any intent, respond with {"intent": null, "context": {}}.`
        },
        {
            role: 'user',
            content: text
        }
    ];
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

Example flow:
User: "I paid for transport"
Your response: {"status": "incomplete", "reply": "Got it, transport expense. How much did you pay?"}
User: "1500"
Your response: {"status": "incomplete", "reply": "Okay, 1500. Could you give a brief description for this expense? (e.g., 'delivery to customer')" }
User: "delivery to Ikeja"
Your response: {"status": "complete", "data": {"category": "transport", "amount": 1500, "description": "delivery to Ikeja"}}
`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const responseJson = await callDeepSeek(messages, 0.5);
    const response = JSON.parse(responseJson);
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];

    return { ...response, memory: updatedHistory };
}
