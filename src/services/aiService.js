import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * A generic function to call the DeepSeek Chat Completions API.
 * @param {Array<object>} messages The message history for the chat.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function callDeepSeek(messages) {
  try {
    const response = await axios.post(DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.1,
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

/**
 * Extracts both business name and email from a single text.
 * @param {string} text The user's message.
 * @returns {Promise<{businessName: string|null, email: string|null}>} An object containing the extracted details.
 */
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


/**
 * Extracts a currency from text and standardizes it to a 3-letter ISO code.
 * @param {string} text The user's message (e.g., "Naira", "dollars", "GHS", "₦").
 * @returns {Promise<{currency: string|null}>} An object with the ISO code, e.g., { "currency": "NGN" }.
 */
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
