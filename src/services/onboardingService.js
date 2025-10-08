import { sendOtpEmail } from './notificationService.js';
import { sendOnboardingMenu } from './menuService.js';
import * as aiService from './aiService.js';
import { sendMessage } from './whatsappService.js';

/**
 * Manages the multi-step onboarding process for new users.
 * This function acts as a state machine based on the conversation state.
 * @param {object} message - The parsed WhatsApp message object.
 * @param {object} collections - The MongoDB collections.
 * @param {object} user - The user document from the database.
 * @param {object} conversation - The conversation document from the database.
 */
export async function handleOnboardingStep(message, collections, user, conversation) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = user.userId;
    const messageText = message.text;

    const currentState = conversation.state || 'onboarding_started';

    switch (currentState) {
        case 'onboarding_started':
            // This is the user's very first interaction.
            await conversationsCollection.updateOne(
                { userId: senderId }, 
                { $set: { state: 'onboarding_collecting_details' } }
            );
            await sendMessage(senderId, "👋 Welcome to Fynax Bookkeeper! To get started, could you please tell me your *business name* and your *email address*?");
            break;

        case 'onboarding_collecting_details':
            // User has replied. Use AI to extract info.
            const extractedDetails = await aiService.extractOnboardingDetails(messageText);

            // --- ROBUST UPDATE LOGIC ---
            // 1. Clean the AI output to avoid saving null/undefined values.
            const updates = {};
            if (extractedDetails.businessName) {
                updates.storeName = extractedDetails.businessName;
            }
            if (extractedDetails.email) {
                updates.email = extractedDetails.email;
            }

            // 2. If the AI found any valid details, update the database.
            if (Object.keys(updates).length > 0) {
                await usersCollection.updateOne({ userId: senderId }, { $set: updates });
            }

            // 3. Re-fetch the user to get the most up-to-date data before making a decision.
            const freshUser = await usersCollection.findOne({ userId: senderId });

            // 4. Now, check what we have and what we still need.
            if (freshUser.storeName && freshUser.email) {
                // We have both! Move to OTP verification.
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry
                
                await conversationsCollection.updateOne(
                    { userId: senderId }, 
                    { $set: { otp, otpExpires, state: 'onboarding_verifying_otp' } }
                );
                
                const emailSent = await sendOtpEmail(freshUser.email, otp, freshUser.storeName);

                if (emailSent) {
                    await sendMessage(senderId, `Perfect! 📧 A 6-digit verification code has been sent to *${freshUser.email}*. Please check your inbox (and spam folder) and enter the code here to continue.`);
                } else {
                    await sendMessage(senderId, `I tried to send an email to *${freshUser.email}*, but it failed. Please double-check and provide a correct email address.`);
                    // Clear the bad email so we can ask for it again.
                    await usersCollection.updateOne({ userId: senderId }, { $unset: { email: "" } }); 
                }

            } else if (freshUser.storeName) {
                await sendMessage(senderId, `Great, I have your business name as *${freshUser.storeName}*. ✅\n\nNow, what's your *email address*?`);
            } else if (freshUser.email) {
                await sendMessage(senderId, `Thanks for the email! What is your *business name*?`);
            } else {
                await sendMessage(senderId, "I didn't quite catch that. Could you please tell me your *business name* and *email address* so we can get you set up?");
            }
            break;

        case 'onboarding_verifying_otp':
            const userOTP = messageText.replace(/\D/g, ''); // Extract only digits
            
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
                await conversationsCollection.updateOne(
                    { userId: senderId }, 
                    { $set: { state: 'onboarding_needs_currency' }, $unset: { otp: "", otpExpires: "" } }
                );
                await sendMessage(senderId, "Great news! Your email has been successfully verified. ✅\n\nNow, to complete your setup, what is your *primary currency*? (e.g., Naira, Dollars, GHS)");
            } else {
                await sendMessage(senderId, "That code doesn't seem to be correct. Please check your email and try again.");
            }
            break;

        case 'onboarding_needs_currency':
            const currencyCode = await aiService.extractCurrency(messageText);
            if (currencyCode) {
                await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currencyCode.toUpperCase() } });
                // ONBOARDING COMPLETE: Unset the state to allow user to access main AI.
                await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } }); 
                await sendMessage(senderId, `Setup complete! Your currency is set to *${currencyCode.toUpperCase()}*.`);
                await sendOnboardingMenu(senderId); // Send the main menu
            } else {
                await sendMessage(senderId, "I didn't understand that currency. Please tell me your currency (e.g., NGN, USD, GHS).");
            }
            break;
    }
}
