import { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import 'dotenv/config';
import { MongoClient } from 'mongodb';

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
        db = mongoClient.db("bookkeeperDB");
        console.log("✅ Successfully connected to MongoDB.");
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB:", error);
        process.exit(1);
    }

    // --- BAILEYS AUTHENTICATION ---
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // --- SOCKET CONNECTION ---
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
    });

    // --- CONNECTION LISTENER ---
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

    // --- NEW: MESSAGE HANDLING LOGIC ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];

        // Ensure the message is not from the bot itself and has content
        if (!msg.key.fromMe && msg.message && msg.message.conversation) {
            const senderId = msg.key.remoteJid;
            const messageText = msg.message.conversation.trim();

            let type = '';
            if (messageText.startsWith('+')) type = 'income';
            if (messageText.startsWith('-')) type = 'expense';

            // If it's not a command, do nothing
            if (type === '') return;

            // Parse the command: e.g., "+ 5000 from client"
            const parts = messageText.substring(1).trim().split(' ');
            const amount = parseFloat(parts[0]);
            
            // Validate the amount
            if (isNaN(amount)) {
                await sock.sendMessage(senderId, { text: "❌ Invalid amount. Please use a number. \nExample: `+ 5000 rent`" });
                return;
            }

            const description = parts.slice(1).join(' ');
            if (!description) {
                 await sock.sendMessage(senderId, { text: "❌ Please provide a description. \nExample: `+ 5000 rent`" });
                return;
            }

            // Prepare data for the database
            const transactionData = {
                userId: senderId,
                type: type,
                amount: amount,
                description: description,
                createdAt: new Date(),
            };

            // Save to database and send confirmation
            try {
                const transactions = db.collection('transactions');
                await transactions.insertOne(transactionData);
                await sock.sendMessage(senderId, { text: '✅ Transaction logged successfully!' });
                console.log('Logged transaction for', senderId);
            } catch (error) {
                console.error("Failed to log transaction:", error);
                await sock.sendMessage(senderId, { text: 'Sorry, there was an error saving your transaction.' });
            }
        }
    });
}

// Run the bot
connectToWhatsApp();
