import { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
// We no longer import connectToDB here
import { handleMessage } from './messageHandler.js';

const processingUsers = new Set();

/**
 * Starts the WhatsApp bot.
 * @param {object} collections - The MongoDB collections object.
 */
export async function startBot(collections) {
    console.log("Starting Bot...");
    // We no longer call connectToDB(). We receive 'collections'.

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // We fixed this earlier
        auth: state,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        // We removed the QR logic, as printQRInTerminal handles it.
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to:', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                // We pass collections to the retry
                startBot(collections);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connection opened!');
        }
    });
    
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const senderId = msg.key.remoteJid;

            if (processingUsers.has(senderId)) {
                return;
            }

            processingUsers.add(senderId);

            try {
                // Pass collections to the handler
                await handleMessage(sock, msg, collections);
            } catch (error) {
                console.error("Unhandled error in message handler pipeline:", error);
            } finally {
                processingUsers.delete(senderId);
            }
        }
    });
}
