import bcrypt from 'bcrypt';
import * as whatsappService from './services/whatsappService.js';
import * as adminService from './services/adminService.js';
import * as liveChatService from './services/liveChatService.js';
import * as aiService from './services/aiService.js';
import { handleOnboardingStep } from './services/onboardingService.js';
import { handleTaskStep } from './taskHandler.js';

const ADMIN_NUMBERS = ['2348105294232', '2348146817448'];
const SALT_ROUNDS = 10;

export async function handleWebhook(body, collections) {
    const message = whatsappService.parseWebhookMessage(body);
    if (!message) return;

    try {
        await _processIncomingMessage(message, collections);
    } catch (error) {
        console.error("Fatal error processing message:", error);
        await whatsappService.sendMessage(message.from, "Sorry, I encountered a critical error. The developers have been notified.");
    }
}

async function _processIncomingMessage(message, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = message.from;
    
    let user = await usersCollection.findOne({ userId: senderId });
    let conversation = await conversationsCollection.findOne({ userId: senderId });

    if (!user) {
        const normalizedSenderId = senderId.split('@')[0];
        const isAdmin = ADMIN_NUMBERS.includes(normalizedSenderId);
        const role = isAdmin ? 'admin' : 'user';
        const tempPassword = `fynax@${Math.floor(Math.random() * 10000)}`;
        const hashedPassword = await bcrypt.hash(tempPassword, SALT_ROUNDS);
        user = { 
            userId: senderId, role, isBlocked: false, 
            websitePassword: hashedPassword, createdAt: new Date(), emailVerified: false 
        };
        await usersCollection.insertOne(user);
        
        conversation = { 
            userId: senderId, sessionId: senderId,
            state: 'onboarding_started', history: [] 
        };
        await conversationsCollection.insertOne(conversation);
    }

    if (user.isBlocked) return;

    if (message.text && message.text.startsWith('/') && user.role === 'admin') {
        return await adminService.handleAdminCommand(message.text, collections, user);
    }
    if (conversation?.chatState === 'live') {
        return await liveChatService.forwardLiveMessage(message, collections, user);
    }

    const currentState = conversation?.state || 'idle';

    if (!user.emailVerified || !user.currency || currentState.startsWith('onboarding_')) {
        await handleOnboardingStep(message, collections, user, conversation);

    } else if (currentState.startsWith('collecting_')) {
        await handleTaskStep(message, collections, user, conversation);

    } else {
        const intentText = message.buttonId ? `I want to ${message.buttonId.replace('_', ' ')}` : message.text;
        const intent = await aiService.routeUserIntent(intentText, collections, senderId);

        if (intent.tool) {
            // Check if the router provided args, meaning the tool is ready to run.
            if (intent.args) {
                await handleTaskStep(message, collections, user, conversation, true, intent.args);
            } else {
                const newState = `collecting_${intent.tool}_details`;
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: newState } });
                const updatedConversation = await conversationsCollection.findOne({ userId: senderId });
                await handleTaskStep(message, collections, user, updatedConversation, true);
            }
        } else {
            await whatsappService.sendMessage(senderId, intent.responseText);
        }
    }
}
