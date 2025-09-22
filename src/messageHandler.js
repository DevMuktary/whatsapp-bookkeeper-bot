import { processMessageWithAI } from './services/aiService.js';
import { handleOnboarding } from './services/onboardingService.js';

/**
 * Main message handler (Router)
 * This function routes incoming messages to the correct service.
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
            await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
            conversation = (await conversationsCollection.updateOne(
                { userId: senderId }, 
                { $set: { state: 'awaiting_store_name', history: [] } }, 
                { upsert: true }
            )).upsertedId;
            
            await sock.sendMessage(senderId, { text: `👋 Welcome to Fynax Bookkeeper, your new AI Bookkeeping Assistant!\n\nTo get started, please tell me the name of your business or store.` });
            return;
        }

        // --- 2. Check for Onboarding State ---
        if (conversation?.state) {
            const isHandledByOnboarding = await handleOnboarding(sock, messageText, collections, senderId, conversation.state);
            // If true, onboarding sent a reply and we stop.
            // If false, onboarding is finished and we let the message proceed to the AI.
            if (isHandledByOnboarding) {
                return;
            }
        }
        
        // --- 3. (Placeholder) Check for Live Chat State ---
        // if (conversation?.chatState === 'live') {
        //     await handleLiveChatMessage(sock, msg, collections, senderId);
        //     return;
        // }

        // --- 4. (Placeholder) Check for Blocked User ---
        // if (user?.isBlocked) {
        //     // We can choose to send a message or just ignore
        //     return; 
        // }

        // --- 5. If all checks pass, process with AI ---
        await sock.sendPresenceUpdate('composing', senderId);
        await processMessageWithAI(messageText, collections, senderId, sock);
        
    } catch (error) {
        // This is the main catch-all for any unhandled errors from the services
        console.error("Fatal error in messageHandler router:", error);
        await sock.sendMessage(senderId, { text: "Sorry, I encountered a critical error and couldn't process your request. Please try again." });
    } finally {
        // Always set presence to paused
        await sock.sendPresenceUpdate('paused', senderId);
    }
}
