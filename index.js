import { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

// --- DATABASE SETUP ---
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is not set.");
}
const mongoClient = new MongoClient(mongoUri);
let db;

// --- MAIN BOT LOGIC ---
async function connectToWhatsApp() {
    console.log("Starting Bot...");
    
    // --- DATABASE CONNECTION ---
    try {
        await mongoClient.connect();
        db = mongoClient.db("bookkeeperDB"); // You can name your database here
        console.log("✅ Successfully connected to MongoDB.");
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB:", error);
        process.exit(1); // Exit if we can't connect to the DB
    }

    // --- BAILEYS AUTHENTICATION ---
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // --- SOCKET CONNECTION ---
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // We'll use Railway logs as our terminal
        auth: state,
    });

    // --- CONNECTION LISTENER ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("QR Code received, scan with your phone:");
            // qrcode.generate(qr, { small: true }); // Alternative if printQRInTerminal doesn't work well
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to:', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connection opened!');
        }
    });
    
    // --- SAVE CREDENTIALS LISTENER ---
    sock.ev.on('creds.update', saveCreds);

    // --- MESSAGE LISTENER (Phase 1 Logic will go here) ---
    sock.ev.on('messages.upsert', async (m) => {
        // This is where we will process incoming messages
        console.log(JSON.stringify(m, undefined, 2)); // Log incoming messages for now
    });
}

// Run the bot
connectToWhatsApp();
