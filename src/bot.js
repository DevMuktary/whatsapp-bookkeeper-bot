import { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import { connectToDB } from './db.js';
import { handleMessage } from './messageHandler.js';

export async function startBot() {
    console.log("Starting Bot...");
    // --- UPDATE THIS LINE ---
    const { usersCollection, transactionsCollection, productsCollection } = await connectToDB();

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
            // --- AND UPDATE THIS LINE ---
            await handleMessage(sock, msg, { usersCollection, transactionsCollection, productsCollection });
        }
    });
}
