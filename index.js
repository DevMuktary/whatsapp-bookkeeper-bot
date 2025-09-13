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

// --- COLLECTIONS ---
let usersCollection;
let transactionsCollection;

// --- MAIN BOT LOGIC ---
async function connectToWhatsApp() {
    console.log("Starting Bot...");
    
    // --- DATABASE CONNECTION ---
    try {
        await mongoClient.connect();
        db = mongoClient.db("bookkeeperDB");
        // Initialize collections
        usersCollection = db.collection('users');
        transactionsCollection = db.collection('transactions');
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

    // --- MESSAGE HANDLING LOGIC ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];

        if (!msg.key.fromMe && msg.message && msg.message.conversation) {
            const senderId = msg.key.remoteJid;
            const messageText = msg.message.conversation.trim();

            // --- USER ONBOARDING ---
            let user = await usersCollection.findOne({ userId: senderId });
            if (!user) {
                const newUser = {
                    userId: senderId,
                    createdAt: new Date()
                };
                await usersCollection.insertOne(newUser);
                // Send welcome message
                const welcomeMessage = `👋 Welcome to your AI Bookkeeping Assistant!\n\nI'm here to help you track your finances effortlessly.\n\n*To log income:* \nStart your message with a plus sign (+).\nExample: \`+ 15000 Payment from client\`\n\n*To log an expense:* \nStart your message with a minus sign (-).\nExample: \`- 500 Fuel for generator\`\n\nTo see your monthly summary, just send: \`/summary\`\n\nLet's get started!`;
                await sock.sendMessage(senderId, { text: welcomeMessage });
                console.log('New user onboarded:', senderId);
                return; // Stop further processing for the first message
            }

            // --- COMMAND HANDLING ---

            // SUMMARY COMMAND
            if (messageText.toLowerCase() === '/summary') {
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

                // MongoDB Aggregation Pipeline
                const summary = await transactionsCollection.aggregate([
                    { $match: { userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } } },
                    { $group: { _id: "$type", totalAmount: { $sum: "$amount" } } }
                ]).toArray();

                let totalIncome = 0;
                let totalExpense = 0;

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

            // TRANSACTION COMMANDS (+/-)
            let type = '';
            if (messageText.startsWith('+')) type = 'income';
            if (messageText.startsWith('-')) type = 'expense';
            
            if (type !== '') {
                const parts = messageText.substring(1).trim().split(' ');
                const amount = parseFloat(parts[0]);
                
                if (isNaN(amount)) {
                    await sock.sendMessage(senderId, { text: "❌ Invalid amount. Please use a number. \nExample: `+ 5000 rent`" });
                    return;
                }

                const description = parts.slice(1).join(' ');
                if (!description) {
                    await sock.sendMessage(senderId, { text: "❌ Please provide a description. \nExample: `+ 5000 rent`" });
                    return;
                }

                const transactionData = {
                    userId: senderId,
                    type: type,
                    amount: amount,
                    description: description,
                    createdAt: new Date(),
                };

                try {
                    await transactionsCollection.insertOne(transactionData);
                    await sock.sendMessage(senderId, { text: '✅ Transaction logged successfully!' });
                } catch (error) {
                    console.error("Failed to log transaction:", error);
                    await sock.sendMessage(senderId, { text: 'Sorry, there was an error saving your transaction.' });
                }
                return;
            }
        }
    });
}

// Run the bot
connectToWhatsApp();
