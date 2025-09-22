import { processMessageWithAI } from './services/aiService.js';
import { handleOnboarding } from './services/onboardingService.js';
import { handleAdminCommand } from './services/adminService.js';
import * as liveChatService from './services/liveChatService.js'; // <-- NEW IMPORT
import bcrypt from 'bcrypt';

const ADMIN_NUMBERS = ['2348105294232', '2348146817448'];
const SALT_ROUNDS = 10;

/**
 * Main message handler (Router)
 */
export async function handleMessage(sock, msg, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = msg.key.remoteJid;
    
    const messageContent = msg.message;
    if (!messageContent) return;

    const messageText = messageContent.conversation || messageContent.extendedTextMessage?.text;
    if (!messageText || messageText.trim() === '') return;

    try {
        let user = await usersCollection.findOne({ userId: senderId });
        let conversation = await conversationsCollection.findOne({ userId: senderId });

        // --- 1. New User Onboarding ---
        if (!user) {
            const normalizedSenderId = senderId.split('@')[0];
            const isAdmin = ADMIN_NUMBERS.includes(normalizedSenderId);
            const role = isAdmin ? 'admin' : 'user';
            const tempPassword = `fynax@${Math.floor(Math.random() * 10000)}`;
            const hashedPassword = await bcrypt.hash(tempPassword, SALT_ROUNDS);
            const newUser = {
                userId: senderId, role: role, isBlocked: false,
                websitePassword: hashedPassword, createdAt: new Date(),
            };
            await usersCollection.insertOne(newUser);
            user = newUser; 
            const newConversation = {
                userId: senderId, state: 'awaiting_store_name', history: []
            };
            await conversationsCollection.insertOne(newConversation);
            conversation = newConversation;
            await sock.sendMessage(senderId, { text: `👋 Welcome to Fynax Bookkeeper, your new AI Bookkeeping Assistant!\n\nTo get started, please tell me the name of your business or store.` });
            if (isAdmin) {
                await sock.sendMessage(senderId, { text: `🔑 *Admin Access Granted.*\nYour temporary web password is: \`${tempPassword}\`\nYou can change it with /setpass [your_phone] [new_pass]\nType /help for all commands.` });
            }
            return;
        }

        // --- 2. Check for Admin Command ---
        if (messageText.startsWith('/') && user.role === 'admin') {
            await handleAdminCommand(sock, messageText, collections, user);
            return; // Admin command handled, stop.
        }

        // --- NEW: 3. Check for Live Chat State ---
        if (conversation?.chatState === 'live') {
            // User is in 'live chat' mode. Forward their message to admins.
            await liveChatService.forwardLiveMessage(sock, msg, collections, user);
            return; // Bot is paused. Stop.
        }

        // --- 4. Check for Onboarding State ---
        if (conversation?.state) {
            const isHandledByOnboarding = await handleOnboarding(sock, messageText, collections, senderId, conversation.state);
            if (isHandledByOnboarding) {
                return;
            }
        }
        
        // --- 5. Check for Blocked User ---
        if (user?.isBlocked) {
            return; // Ignore.
        }

        // --- 6. If all checks pass, process with AI ---
        await sock.sendPresenceUpdate('composing', senderId);
        await processMessageWithAI(messageText, collections, senderId, sock, user); // Pass 'user'
        
    } catch (error) {
        console.error("Fatal error in messageHandler router:", error);
        await sock.sendMessage(senderId, { text: "Sorry, I encountered a critical error and couldn't process your request. Please try again." });
    } finally {
        await sock.sendPresenceUpdate('paused', senderId);
    }
}
