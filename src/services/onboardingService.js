import { sendOtpEmail } from './notificationService.js';
import { sendOnboardingMenu } from './menuService.js';
import * as aiService from './aiService.js';
import { sendMessage } from './whatsappService.js';

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
            const aiResponse = await aiService.processOnboardingMessage(messageText, collections, senderId);
            
            try {
                const details = JSON.parse(aiResponse);
                // If this succeeds, the AI has finished and sent us the data.
                
                if (details.businessName && details.email) {
                    await usersCollection.updateOne({ userId: senderId }, { $set: { storeName: details.businessName, email: details.email } });
                    
                    const otp = Math.floor(100000 + Math.random() * 900000).toString();
                    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
                    
                    await conversationsCollection.updateOne(
                        { userId: senderId }, 
                        { $set: { otp, otpExpires, state: 'onboarding_verifying_otp' } }
                    );
                    
                    const emailSent = await sendOtpEmail(details.email, otp, details.businessName);

                    if (emailSent) {
                        const successMessage = `Perfect! I have your business name as *${details.businessName}* and your email as *${details.email}*.\n\n📧 A 6-digit verification code has been sent to your inbox. Please enter the code here to continue.`;
                        await sendMessage(senderId, successMessage);
                    } else {
                        const failureMessage = `Great, I've saved your details! However, I had trouble sending the verification email to *${details.email}*.\n\nPlease check that it's correct. You can provide a new email address to try again.`;
                        await sendMessage(senderId, failureMessage);
                        await usersCollection.updateOne({ userId: senderId }, { $unset: { email: "" } }); 
                    }
                } else {
                    // This is a fallback if the JSON is malformed.
                    throw new Error("JSON from AI is missing required fields.");
                }

            } catch (error) {
                // If JSON.parse fails, it's a regular conversational message.
                // We just send it back to the user.
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
