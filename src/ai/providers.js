import axios from 'axios';
import OpenAI from 'openai';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

export const openai = new OpenAI({ apiKey: config.openai.apiKey });

export async function callDeepSeek(messages, temperature = 0.1, enforceJson = true) {
  try {
    const payload = {
      model: 'deepseek-chat',
      messages: messages,
      temperature: temperature,
    };
    
    if (enforceJson && messages.some(m => m.role === 'system' && m.content.toLowerCase().includes('json'))) {
        payload.response_format = { type: "json_object" };
    }

    const response = await axios.post(DEEPSEEK_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseek.apiKey}`
      },
      timeout: 8000 // Timeout to prevent hanging
    });

    const content = response.data.choices[0].message.content;

    if (enforceJson && typeof content === 'string' && content.trim().startsWith('{')) {
         try {
             return JSON.parse(content);
         } catch (parseError) {
             logger.warn("AI response JSON parse error:", content);
             return content;
         }
    }
    return content;

  } catch (error) {
    logger.error('DeepSeek API Error:', error.message);
    throw error; 
  }
}
