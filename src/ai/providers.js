import axios from 'axios';
import OpenAI from 'openai';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

export const openai = new OpenAI({ apiKey: config.openai.apiKey });

// [NEW] Helper to safely parse JSON response
function parseContent(content, enforceJson) {
    if (enforceJson && typeof content === 'string' && content.trim().startsWith('{')) {
         try {
             return JSON.parse(content);
         } catch (parseError) {
             logger.warn("AI response JSON parse error:", content);
             return content;
         }
    }
    return content;
}

export async function callDeepSeek(messages, temperature = 0.1, enforceJson = true) {
  // 1. Try DeepSeek First
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
      timeout: 5000 // Short timeout (5s) so we can switch quickly
    });

    const content = response.data.choices[0].message.content;
    return parseContent(content, enforceJson);

  } catch (error) {
    logger.warn(`⚠️ DeepSeek Failed (${error.message}). Switching to OpenAI Fallback...`);
    
    // 2. Fallback to OpenAI
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo-0125", // Cheaper, fast fallback
            messages: messages,
            temperature: temperature,
            response_format: enforceJson ? { type: "json_object" } : undefined
        });
        
        const content = completion.choices[0].message.content;
        return parseContent(content, enforceJson);

    } catch (openAiError) {
        logger.error('❌ All AI Providers Failed:', openAiError.message);
        throw openAiError; 
    }
  }
}
