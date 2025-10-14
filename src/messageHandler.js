import bcrypt from 'bcrypt';
import * as whatsappService from './services/whatsappService.js';
import * as adminService from './services/adminService.js';
import * as liveChatService from './services/liveChatService.js';
import * as aiService from './services/aiService.js';
import * as accountingService from './services/accountingService.js';
import * as reportService from './services/reportService.js';
import { handleOnboardingStep } from './services/onboardingService.js';
import { handleTaskStep } from './taskHandler.js';

const ADMIN_NUMBERS = ['2348105294232', '2348146817448'];
const SALT_ROUNDS = 10;

// A map to connect tool names to their actual functions for immediate execution.
const immediateTools = {
    'getInventory': accountingService.getInventory,
    'generateInventoryReport': reportService.generateInventoryReport,
    // Add other simple tools here, e.g., getMonthlySummary
};

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
        // ... new user creation logic ... (omitted for brevity, no changes needed)
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
        // --- THIS IS THE NEW, RELIABLE LOGIC ---
        const intentText = message.buttonId ? `I want to ${message.buttonId.replace(/_/g, ' ')}` : message.text;
        const intent = await aiService.routeUserIntent(intentText);

        if (intent.tool) {
            const schema = aiService.toolSchemas[intent.tool];
            const executor = immediateTools[intent.tool];
            
            if (executor && Object.keys(schema.args).length === 0) {
                // Case 1: The tool is simple and needs no arguments. Execute it immediately.
                console.log(`Executing immediate tool: ${intent.tool}`);
                const result = await executor({}, collections, senderId);
                await whatsappService.sendMessage(senderId, result.message);
                 // Send a follow up prompt
                setTimeout(() => {
                    whatsappService.sendInteractiveMessage(senderId, "Is there anything else I can help with?", [
                        { id: 'log_sale', title: 'Log a Sale' },
                        { id: 'log_expense', title: 'Log an Expense' },
                        { id: 'add_stock', title: 'Add New Stock' },
                    ]);
                }, 1500);

            } else {
                // Case 2: The tool needs arguments. Start the conversational collection process.
                console.log(`Starting conversational task: ${intent.tool}`);
                const newState = `collecting_${intent.tool}_details`;
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: newState } });
                const updatedConversation = await conversationsCollection.findOne({ userId: senderId });
                await handleTaskStep(message, collections, user, updatedConversation, true);
            }
        } else {
            // Case 3: The AI couldn't determine a specific tool.
            await whatsappService.sendMessage(senderId, "I'm not quite sure how to help with that. You can try logging a sale, adding stock, or asking for a report.");
        }
    }
}
