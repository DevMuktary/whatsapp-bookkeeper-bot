import bcrypt from 'bcrypt';
import * as whatsappService from './services/whatsappService.js';
import * as adminService from './services/adminService.js';
import * as liveChatService from './services/liveChatService.js';
import * as aiService from './services/aiService.js';

const ADMIN_NUMBERS = ['2348105294232', '2348146817448'];
const SALT_ROUNDS = 10;

export async function handleWebhook(body, collections) {
    const message = whatsappService.parseWebhookMessage(body);
    if (!message) return;

    try {
        await _processIncomingMessage(message, collections);
    } catch (error) {
        console.error("Fatal error processing message:", error);
        await whatsappService.sendMessage(message.from, "Sorry, I encountered a critical error. Please try again later.");
    }
}

async function _processIncomingMessage(message, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = message.from;
    const messageText = message.text;

    let user = await usersCollection.findOne({ userId: senderId });
    let conversation = await conversationsCollection.findOne({ userId: senderId });

    if (!user) {
        const normalizedSenderId = senderId.split('@')[0];
        const isAdmin = ADMIN_NUMBERS.includes(normalizedSenderId);
        const role = isAdmin ? 'admin' : 'user';
        const tempPassword = `fynax@${Math.floor(Math.random() * 10000)}`;
        const hashedPassword = await bcrypt.hash(tempPassword, SALT_ROUNDS);
        user = { 
            userId: senderId, 
            role, 
            isBlocked: false, 
            websitePassword: hashedPassword, 
            createdAt: new Date(), 
            emailVerified: false,
        };
        await usersCollection.insertOne(user);
        
        conversation = { 
            userId: senderId,
            sessionId: senderId, // For LangChain history
            history: [] 
        };
        await conversationsCollection.insertOne(conversation);
    }

    if (user.isBlocked) {
        return; // Ignore blocked users
    }

    if (message.type === 'button_reply') {
        let aiTriggerText = '';
        switch (message.buttonId) {
            case 'log_sale':
                aiTriggerText = 'I want to log a sale';
                break;
            case 'log_expense':
                aiTriggerText = 'I want to log an expense';
                break;
            case 'add_stock':
                aiTriggerText = 'I want to add new stock';
                break;
        }

        if (aiTriggerText) {
            const aiResponseText = await aiService.processMessageWithAI(aiTriggerText, collections, senderId, user);
            if (aiResponseText) {
                await whatsappService.sendMessage(senderId, aiResponseText);
            }
        }
        return;
    }

    if (messageText.startsWith('/') && user.role === 'admin') {
        await adminService.handleAdminCommand(messageText, collections, user);
        return;
    }
    
    if (conversation?.chatState === 'live') {
        await liveChatService.forwardLiveMessage(message, collections, user);
        return;
    }
    
    let aiResponseText;
    // If the user hasn't finished onboarding (verified email and set currency), route them to the onboarding AI.
    if (!user.emailVerified || !user.currency) {
        aiResponseText = await aiService.processOnboardingMessage(messageText, collections, senderId, user);
    } else {
        // Otherwise, they are a regular user. Route them to the main AI.
        aiResponseText = await aiService.processMessageWithAI(messageText, collections, senderId, user);
    }
    
    if (aiResponseText) {
        await whatsappService.sendMessage(senderId, aiResponseText);
    }
}
