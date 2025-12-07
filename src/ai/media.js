import axios from 'axios';
import OpenAI from 'openai';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { openai } from './providers.js'; // Uses the shared instance

async function downloadWhatsAppMedia(mediaId) {
    try {
        const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        const mediaUrl = urlRes.data.url;

        const mediaRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${config.whatsapp.token}` }
        });
        return mediaRes.data;
    } catch (error) {
        logger.error('Error downloading media:', error.message);
        throw new Error('Failed to download media file.');
    }
}

export async function transcribeAudio(mediaId) {
    try {
        const audioBuffer = await downloadWhatsAppMedia(mediaId);
        // OpenAI requires a File object or similar. We convert buffer to file.
        const file = await OpenAI.toFile(audioBuffer, 'voice_note.ogg', { type: 'audio/ogg' });
        
        const transcription = await openai.audio.transcriptions.create({
            file: file,
            model: "whisper-1",
        });
        return transcription.text;
    } catch (error) {
        logger.error('Audio transcription failed:', error.message);
        return null; // Return null so the handler knows it failed
    }
}

export async function analyzeImage(mediaId, caption = "") {
    try {
        const imageBuffer = await downloadWhatsAppMedia(mediaId);
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o", // Use GPT-4o for vision
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Extract relevant bookkeeping details from this image. If it's a receipt, list items, total amount, and date. If it's a product, describe it. User caption: "${caption}"` },
                        { type: "image_url", image_url: { url: dataUrl } },
                    ],
                },
            ],
            max_tokens: 300,
        });
        return response.choices[0].message.content;
    } catch (error) {
        logger.error('Image analysis failed:', error.message);
        return null;
    }
}
