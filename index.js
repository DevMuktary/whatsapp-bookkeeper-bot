import { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- CONFIGURATION ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 2,
    timeout: 60 * 1000,
});
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error("MONGODB_URI environment variable is not set.");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY environment variable is not set.");

// --- DATABASE SETUP ---
const mongoClient = new MongoClient(mongoUri);
let db, usersCollection, transactionsCollection;

// --- ROBUST AUDIO PROCESSING FUNCTION ---
async function processAudio(audioBuffer) {
    const tempPath = join(tmpdir(), `audio-${Date.now()}.ogg`);
    try {
        // Write the original audio buffer to a temporary file
        await fsPromises.writeFile(tempPath, audioBuffer);

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: 'whisper-1',
        });
        
        return transcription.text;
    } catch (error) {
        console.error("Error in audio processing:", error);
        return null;
    } finally {
        // Clean up the temporary file
        await fsPromises.unlink(tempPath).catch(err => console.error("Failed to delete temp audio file:", err));
    }
}


// --- MAIN BOT LOGIC ---
async function handleMessage(sock, msg) {
    let messageText = '';
    const senderId = msg.key.remoteJid;

    if (msg.message?.audioMessage) {
        await sock.sendMessage(senderId, { text: "Processing your voice note... 🎙️" });
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const transcribedText = await processAudio(buffer);
        if (transcribedText) {
            messageText = transcribedText;
            console.log(`Transcribed from audio: "${messageText}"`);
        } else {
            await sock.sendMessage(senderId, { text: "Sorry, I couldn't understand the audio. Please try again." });
            return;
        }
    } else if (msg.message?.conversation) {
        messageText = msg.message.conversation.trim();
    } else {
        return;
    }
    
    let user = await usersCollection.findOne({ userId: senderId });
    if (!user) {
        await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
        const welcomeMessage = `👋 Welcome to your AI Bookkeeping Assistant!\n\nI'm here to help you track your finances effortlessly.\n\n*To log income:* \nStart your message with a plus sign (+).\nExample: \`+ 15000 Payment from client\`\n\n*To log an expense:* \nStart your message with a minus sign (-).\nExample: \`- 500 Fuel for generator\`\n\nTo see your monthly summary, just send: \`/summary\`\n\nYou can also send a voice note with the same commands!`;
        await sock.sendMessage(senderId, { text: welcomeMessage });
        return;
    }

    if (messageText.toLowerCase() === '/summary') {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const summary = await transactionsCollection.aggregate([
            { $match: { userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } } },
            { $group: { _id: "$type", totalAmount: { $sum: "$amount" } } }
        ]).toArray();
        let totalIncome = 0, totalExpense = 0;
        summary.forEach(item => {
            if (item._id === 'income') totalIncome = item.totalAmount;
            if (item._id === 'expense') totalExpense = item.totalAmount;
        });
        const net = totalIncome - totalExpense;
        const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
        const summaryMessage = `📊 *Financial Summary for ${monthName}*\n\n*Total Income:* ₦${totalIncome.toLocaleString()}\n*Total Expense:* ₦${totalExpense.toLocaleString()}\n---------------------\n*Net Balance:* *₦${net.toLocaleString()}*`;
        await sock.sendMessage(senderId, { text: summaryMessage });
        return;
    }
    
    let type = '';
    if (messageText.trim().startsWith('+')) type = 'income';
    if (messageText.trim().startsWith('-')) type = 'expense';
    
    if (type !== '') {
        const parts = messageText.substring(1).trim().split(' ');
        const amount = parseFloat(parts[0].replace(/,/g, ''));
        if (isNaN(amount)) {
            await sock.sendMessage(senderId, { text: "❌ Invalid amount. Please use a number. \nExample: `+ 5000 rent`" });
            return;
        }
        const description = parts.slice(1).join(' ');
        if (!description) {
            await sock.sendMessage(senderId, { text: "❌ Please provide a description. \nExample: `+ 5000 rent`" });
            return;
        }
        try {
            await transactionsCollection.insertOne({ userId: senderId, type, amount, description, createdAt: new Date() });
            await sock.sendMessage(senderId, { text: '✅ Transaction logged successfully!' });
        } catch (error) {
            console.error("Failed to log transaction:", error);
            await sock.sendMessage(senderId, { text: 'Sorry, there was an error saving your transaction.' });
        }
        return;
    }
}


// --- BOILERPLATE CONNECTION LOGIC ---
async function startBot() {
    console.log("Starting Bot...");
    try {
        await mongoClient.connect();
        db = mongoClient.db("bookkeeperDB");
        usersCollection = db.collection('users');
        transactionsCollection = db.collection('transactions');
        console.log("✅ Successfully connected to MongoDB.");
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB:", error);
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("--------------------------------------------------");
            console.log("COPY THE TEXT BELOW and paste it into a QR code generator app/website:");
            console.log(qr);
            console.log("--------------------------------------------------");
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connection opened!');
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            await handleMessage(sock, msg);
        }
    });
}

startBot();
