import { sendOtpEmail } from './notificationService.js';
import { sendOnboardingMenu } from './menuService.js';
import * as aiService from './aiService.js';
import { sendMessage } from './whatsappService.js';
import { MongoDBChatMessageHistory } from "@langchain/mongodb";

const ONBOARDING_COMPLETE_SIGNAL = "[ONBOARDING_DETAILS_COLLECTED]";

/**
 * Manages the multi-step onboarding process for new users.
 */
export async function handleOnboardingStep(message, collections, user, conversation) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = user.userId;
    const messageText = message.text;

    const currentState = conversation.state || 'onboarding_started';

    switch (currentState) {
        case 'onboarding_started':
            await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'onboarding_collecting_details' } });
            await sendMessage(senderId, "👋 Welcome to Fynax Bookkeeper! To get started, could you please tell me your *business name* and your *email address*?");
            break;

        case 'onboarding_collecting_details':
            // Use the new conversational AI to handle the back-and-forth
            const aiResponse = await aiService.processOnboardingMessage(messageText, collections, senderId);

            if (aiResponse.includes(ONBOARDING_COMPLETE_SIGNAL)) {
                // AI signals that it has collected all details.
                const cleanResponse = aiResponse.replace(ONBOARDING_COMPLETE_SIGNAL, "").trim();
                if (cleanResponse) {
                    await sendMessage(senderId, cleanResponse);
                }

                // Now, extract details from the entire conversation history
                const history = new MongoDBChatMessageHistory({
                    collection: collections.conversationsCollection,
                    sessionId: senderId,
                });
                const messages = await history.getMessages();
                const fullConversationText = messages.map(msg => msg.content).join('\n');
                
                const extractedDetails = await aiService.extractOnboardingDetails(fullConversationText);

                if (extractedDetails.businessName && extractedDetails.email) {
                    await usersCollection.updateOne({ userId: senderId }, { $set: { storeName: extractedDetails.businessName, email: extractedDetails.email } });
                    
                    // --- Transition to OTP Verification ---
                    const otp = Math.floor(100000 + Math.random() * 900000).toString();
                    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry
                    
                    await conversationsCollection.updateOne(
                        { userId: senderId }, 
                        { $set: { otp, otpExpires, state: 'onboarding_verifying_otp' } }
                    );
                    
                    const emailSent = await sendOtpEmail(extractedDetails.email, otp, extractedDetails.businessName);
                    if (emailSent) {
                        await sendMessage(senderId, `Perfect! 📧 A 6-digit verification code has been sent to *${extractedDetails.email}*. Please check your inbox (and spam folder) and enter the code here to continue.`);
                    } else {
                        await sendMessage(senderId, `I tried to send an email to *${extractedDetails.email}*, but it failed. Please double-check and provide a correct email address.`);
                        await usersCollection.updateOne({ userId: senderId }, { $unset: { email: "" } }); 
                    }
                } else {
                    // This is a fallback in case extraction fails
                    await sendMessage(senderId, "I seem to have had a little trouble processing your details. Could we try one more time? Please tell me your business name and email.");
                }

            } else {
                // The conversation is still ongoing, just send the AI's response.
                await sendMessage(senderId, aiResponse);
            }
            break;

        case 'onboarding_verifying_otp':
            const userOTP = messageText.replace(/\D/g, '');
            if (!conversation.otp || !conversation.otpExpires) {
                await sendMessage(senderId, "It seems there was an issue. Let's try sending that verification email again. What is your email address?");
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'onboarding_collecting_details' } });
                return;
            }
            if (new Date() > new Date(conversation.otpExpires)) {
                await sendMessage(senderId, "That code has expired. Let's send a new one. What is your email address?");
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'onboarding_collecting_details' } });
                await usersCollection.updateOne({ userId: senderId }, { $unset: { email: "" } });
                return;
            }
            if (conversation.otp === userOTP) {
                await usersCollection.updateOne({ userId: senderId }, { $set: { emailVerified: true } });
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'onboarding_needs_currency' }, $unset: { otp: "", otpExpires: "" } });
                await sendMessage(senderId, "Great news! Your email has been successfully verified. ✅\n\nNow, to complete your setup, what is your *primary currency*? (e.g., Naira, Dollars, GHS)");
            } else {
                await sendMessage(senderId, "That code doesn't seem to be correct. Please check your email and try again.");
            }
            break;

        case 'onboarding_needs_currency':
            const currencyCode = await aiService.extractCurrency(messageText);
            if (currencyCode) {
                await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currencyCode.toUpperCase() } });
                await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } }); 
                await sendMessage(senderId, `Setup complete! Your currency is set to *${currencyCode.toUpperCase()}*.`);
                await sendOnboardingMenu(senderId);
            } else {
                await sendMessage(senderId, "I didn't understand that currency. Please tell me your currency (e.g., NGN, USD, GHS).");
            }
            break;
    }
}
