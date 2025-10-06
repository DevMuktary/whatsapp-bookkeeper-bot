import bcrypt from 'bcrypt';
import * as whatsappService from './services/whatsappService.js';
import * as onboardingService from './services/onboardingService.js';
import * as adminService from './services/adminService.js';
import * as liveChatService from './services/liveChatService.js';
import * as aiService from './services/aiService.js';

const ADMIN_NUMBERS = ['2348105294232', '2348146817448'];
const SALT_ROUNDS = 10;

/**
 * Main webhook handler.
 * This is called by api.js for every incoming webhook event.
 */
export async function handleWebhook(body, collections) {
    // Parse the message from the complex webhook payload
    const message = whatsappService.parseWebhookMessage(body);

    // If it's not a text message we can handle, do nothing.
    if (!message) {
        return;
    }

    try {
        // Process the extracted message
        await _processIncomingMessage(message, collections);
    } catch (error) {
        console.error("Fatal error processing message:", error);
        // Send a generic failure message to the user
        await whatsappService.sendMessage(message.from, "Sorry, I encountered a critical error and was unable to process your request. Please try again later.");
    }
}

/**
 * Internal function to route and process a validated message.
 * This is the "brain" of the bot.
 */
async function _processIncomingMessage(message, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = message.from;
    const messageText = message.text;

    let user = await usersCollection.findOne({ userId: senderId });
    let conversation = await conversationsCollection.findOne({ userId: senderId });

    // --- 1. New User Onboarding ---
    if (!user) {
        // Create new user
        const normalizedSenderId = senderId.split('@')[0];
        const isAdmin = ADMIN_NUMBERS.includes(normalizedSenderId);
        const role = isAdmin ? 'admin' : 'user';
        const tempPassword = `fynax@${Math.floor(Math.random() * 10000)}`;
        const hashedPassword = await bcrypt.hash(tempPassword, SALT_ROUNDS);
        const newUser = {
            userId: senderId,
            role: role,
            isBlocked: false,
            websitePassword: hashedPassword,
            createdAt: new Date(),
        };
        await usersCollection.insertOne(newUser);
        user = newUser;

        // Create new conversation
        const newConversation = {
            userId: senderId,
            state: 'awaiting_store_name',
            history: []
        };
        await conversationsCollection.insertOne(newConversation);
        conversation = newConversation;
        
        // Send welcome messages using the new service
        await whatsappService.sendMessage(senderId, `👋 Welcome to Fynax Bookkeeper, your new AI Bookkeeping Assistant!\n\nTo get started, please tell me the name of your business or store.`);
        if (isAdmin) {
            await whatsappService.sendMessage(senderId, `🔑 *Admin Access Granted.*\nYour temporary web password is: \`${tempPassword}\`\nYou can change it with /setpass [your_phone] [new_pass]\nType /help for all commands.`);
        }
        return; // Stop here for new users
    }

    // --- 2. Check for Admin Command ---
    if (messageText.startsWith('/') && user.role === 'admin') {
        await adminService.handleAdminCommand(messageText, collections, user);
        return; // Admin command handled, stop.
    }

    // --- 3. Check for Live Chat State ---
    if (conversation?.chatState === 'live') {
        await liveChatService.forwardLiveMessage(message, collections, user);
        return; // Bot is paused. Stop.
    }

    // --- 4. Check for Onboarding State ---
    if (conversation?.state) {
        const isHandled = await onboardingService.handleOnboarding(messageText, collections, senderId, conversation.state);
        if (isHandled) {
            return; // Onboarding sent a reply and we stop.
        }
    }
    
    // --- 5. Check for Blocked User ---
    if (user?.isBlocked) {
        return; // Ignore silently.
    }

    // --- 6. If all checks pass, process with AI ---
    // The AI service now returns text instead of sending a message.
    const aiResponseText = await aiService.processMessageWithAI(messageText, collections, senderId, user);
    
    // If the AI generated a response, send it.
    if (aiResponseText) {
        await whatsappService.sendMessage(senderId, aiResponseText);
    }
}
