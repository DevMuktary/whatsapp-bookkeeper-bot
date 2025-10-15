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
      temperature: 0.1, // Low temperature for deterministic extraction
      response_format: { type: "json_object" } // Enforce JSON output
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
 * Extracts a business name from a user's free-form text.
 * @param {string} text The user's message.
 * @returns {Promise<{businessName: string|null}>} An object containing the extracted name.
 */
export async function extractBusinessName(text) {
  const messages = [
    {
      role: 'system',
      content: "You are an expert entity extractor. Your task is to extract the business name from the user's message. The business name could be a proper noun or a descriptive phrase. Respond ONLY with a JSON object in the format {\"businessName\": \"The Extracted Name\"}. If no clear business name can be found, respond with {\"businessName\": null}."
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
 * Extracts an email address from a user's free-form text.
 * @param {string} text The user's message.
 * @returns {Promise<{email: string|null}>} An object containing the extracted email.
 */
export async function extractEmail(text) {
    const messages = [
      {
        role: 'system',
        content: "You are an expert entity extractor. Your task is to extract an email address from the user's message. Respond ONLY with a JSON object in the format {\"email\": \"user@example.com\"}. If no valid email address can be found, respond with {\"email\": null}."
      },
      {
        role: 'user',
        content: `Here is the message: "${text}"`
      }
    ];
    const responseJson = await callDeepSeek(messages);
    return JSON.parse(responseJson);
}
