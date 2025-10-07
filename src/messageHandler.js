import bcrypt from 'bcrypt';
import * as whatsappService from './services/whatsappService.js';
import * as adminService from './services/adminService.js';
import * as liveChatService from './services/liveChatService.js';
import * as aiService from './services/aiService.js';

const ADMIN_NUMBERS = ['2348105294232', '2348146817448'];
const SALT_ROUNDS = 10;

/**
 * Main webhook handler. This is the entry point for all incoming messages from Meta.
 */
export async function handleWebhook(body, collections) {
    // Parse the complex webhook payload into a simple message object
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
        // Send a generic failure message to the user if anything breaks
        await whatsappService.sendMessage(message.from, "Sorry, I encountered a critical error. Please try again later.");
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

    // --- 1. Handle New Users ---
    if (!user) {
        // Create the new user in the database
        const normalizedSenderId = senderId.split('@')[0];
        const isAdmin = ADMIN_NUMBERS.includes(normalizedSenderId);
        const role = isAdmin ? 'admin' : 'user';
        const tempPassword = `fynax@${Math.floor(Math.random() * 10000)}`;
        const hashedPassword = await bcrypt.hash(tempPassword, SALT_ROUNDS);
        
        user = {
            userId: senderId,
            role: role,
            isBlocked: false,
            websitePassword: hashedPassword,
            createdAt: new Date(),
            emailVerified: false,
        };
        await usersCollection.insertOne(user);
        
        // Create their conversation and set the state to 'onboarding'
        conversation = {
            userId: senderId,
            state: 'onboarding',
            history: []
        };
        await conversationsCollection.insertOne(conversation);
        
        // Don't send a welcome message here. The onboarding AI will handle the greeting.
        // We let the code fall through to the AI router below.
    }

    // --- 2. Check for Blocked User ---
    // This is a high-priority check. If blocked, ignore everything.
    if (user.isBlocked) {
        return; // Ignore silently.
    }

    // --- 3. Check for Admin Command ---
    if (messageText.startsWith('/') && user.role === 'admin') {
        await adminService.handleAdminCommand(messageText, collections, user);
        return; // Admin command handled, stop.
    }

    // --- 4. Check for Live Chat State ---
    if (conversation?.chatState === 'live') {
        await liveChatService.forwardLiveMessage(message, collections, user);
        return; // Bot is paused. Stop.
    }
    
    // --- 5. ROUTE TO THE CORRECT AI PROCESS (Onboarding vs. Main) ---
    let aiResponseText;

    if (conversation?.state?.startsWith('onboarding')) {
        // If the user's state is 'onboarding' or 'onboarding_needs_currency',
        // route them to the specialized onboarding AI.
        aiResponseText = await aiService.processOnboardingMessage(messageText, collections, senderId, user, conversation);
    } else {
        // Otherwise, they are a regular user. Route them to the main AI.
        aiResponseText = await aiService.processMessageWithAI(messageText, collections, senderId, user, conversation);
    }
    
    // If the AI process generated a response, send it.
    if (aiResponseText) {
        await whatsappService.sendMessage(senderId, aiResponseText);
    }
}
