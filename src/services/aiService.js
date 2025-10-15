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

// --- ONBOARDING FUNCTIONS (Unchanged) ---
export async function extractOnboardingDetails(text) { /* ... no changes ... */ }
export async function extractCurrency(text) { /* ... no changes ... */ }


// --- ROUTER AI ---
/**
 * Identifies the user's primary intent from their message.
 * @param {string} text The user's message.
 * @returns {Promise<{intent: string|null, context: object}>}
 */
export async function getIntent(text) {
    const messages = [
        {
            role: 'system',
            content: `You are an intent classification system for a bookkeeping app. Your job is to analyze the user's message and determine their intent. You must respond ONLY with a JSON object. The possible intents are [\"${INTENTS.LOG_SALE}\"]. If the intent is to log a sale, also extract any available details. The JSON format is {"intent": "INTENT_NAME", "context": {"productName": "...", "unitsSold": ..., "amountPerUnit": ..., "customerName": "...", "saleType": "..."}}. If the user's message is conversational or does not match any intent, respond with {"intent": null, "context": {}}.`
        },
        {
            role: 'user',
            content: text
        }
    ];
    const responseJson = await callDeepSeek(messages);
    return JSON.parse(responseJson);
}

// --- WORKER AI ---
/**
 * Manages the conversation to collect all details for a sale.
 * @param {Array<object>} conversationHistory The history of the current data collection conversation.
 * @returns {Promise<{status: string, response: string|object, memory: Array<object>}>}
 */
export async function gatherSaleDetails(conversationHistory) {
    const systemPrompt = `You are a friendly and efficient bookkeeping assistant named Fynax. Your current goal is to collect all the necessary details to log a sale.
You must fill a JSON object with these exact keys: "productName", "unitsSold", "amountPerUnit", "customerName", "saleType". The 'saleType' must be one of ['cash', 'credit', 'bank'].

CONVERSATION RULES:
1.  Analyze the conversation history provided by the user.
2.  If any of the required keys are missing, ask a clear, friendly question to get ONLY the missing information. Do NOT ask for multiple things at once.
3.  Be conversational. For example, if a user provides a product name, acknowledge it before asking the next question.
4.  Once ALL keys are filled, your FINAL response must be a JSON object containing ONLY {"status": "complete", "data": { ... the final sale object ... }}.
5.  While you are still collecting information, your response must be a JSON object in the format {"status": "incomplete", "reply": "Your question or comment to the user."}.

Example flow:
User: "I sold a cake"
Your response: {"status": "incomplete", "reply": "Great! How many cakes did you sell?"}
User: "Just one"
Your response: {"status": "incomplete", "reply": "Understood. What was the price for the cake?"}
...and so on until all data is collected.
`;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    
    // Using a slightly higher temperature for more natural conversation
    const responseJson = await callDeepSeek(messages, 0.5); 
    const response = JSON.parse(responseJson);

    // Append the AI's own response to the history for the next turn
    const updatedHistory = [...conversationHistory, { role: 'assistant', content: responseJson }];
    
    return { ...response, memory: updatedHistory };
}
