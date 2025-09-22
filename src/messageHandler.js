import { processMessageWithAI } from './services/aiService.js';
import { handleOnboarding } from './services/onboardingService.js';
import bcrypt from 'bcrypt'; // <-- NEW: Import bcrypt

// --- NEW: Define Admin Phone Numbers ---
// We strip the '+' and use the country code.
const ADMIN_NUMBERS = ['2348105294232', '2348146817448'];
const SALT_ROUNDS = 10; // For bcrypt hashing

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

        // --- 1. New User Onboarding (UPDATED) ---
        if (!user) {
            // --- NEW: Admin Role & Password Logic ---
            const normalizedSenderId = senderId.split('@')[0]; // "234810..."
            const isAdmin = ADMIN_NUMBERS.includes(normalizedSenderId);
            const role = isAdmin ? 'admin' : 'user';
            
            // Create a secure, temporary password.
            // In the future, we can have the user set this.
            const tempPassword = `fynax@${Math.floor(Math.random() * 10000)}`;
            const hashedPassword = await bcrypt.hash(tempPassword, SALT_ROUNDS);
            
            const newUser = {
                userId: senderId,
                role: role,
                isBlocked: false,
                websitePassword: hashedPassword,
                createdAt: new Date(),
            };

            // This welcome message will be sent AFTER they set their store name.
            if (isAdmin) {
                console.log(`ADMIN USER ${senderId} created.`);
            }
            // --- END OF NEW LOGIC ---

            await usersCollection.insertOne(newUser);
            user = newUser; // Assign the new user object

            const newConversation = {
                userId: senderId,
                state: 'awaiting_store_name',
                history: []
            };

            await conversationsCollection.insertOne(newConversation);
            conversation = newConversation; // Assign the new convo object
            
            await sock.sendMessage(senderId, { text: `👋 Welcome to Fynax Bookkeeper, your new AI Bookkeeping Assistant!\n\nTo get started, please tell me the name of your business or store.` });
            
            if (isAdmin) {
                // Send a special welcome to admins
                await sock.sendMessage(senderId, { text: `🔑 *Admin Access Granted.*\nYour temporary web password is: \`${tempPassword}\`\n\nPlease change this later.` });
            }
            return;
        }

        // --- 2. Check for Onboarding State ---
        if (conversation?.state) {
            const isHandledByOnboarding = await handleOnboarding(sock, messageText, collections, senderId, conversation.state);
            if (isHandledByOnboarding) {
                return;
            }
        }
        
        // --- 3. (Placeholder) Check for Live Chat State ---
        // if (conversation?.chatState === 'live') {
        //     await handleLiveChatMessage(sock, msg, collections, senderId);
        //     return;
        // }

        // --- 4. Check for Blocked User ---
        if (user?.isBlocked) {
            // We'll just ignore blocked users.
            return; 
        }

        // --- 5. If all checks pass, process with AI ---
        await sock.sendPresenceUpdate('composing', senderId);
        await processMessageWithAI(messageText, collections, senderId, sock);
        
    } catch (error) {
        console.error("Fatal error in messageHandler router:", error);
        await sock.sendMessage(senderId, { text: "Sorry, I encountered a critical error and couldn't process your request. Please try again." });
    } finally {
        await sock.sendPresenceUpdate('paused', senderId);
    }
}
