import { sendOtpEmail } from './notificationService.js';
import { sendOnboardingMenu } from './menuService.js';
import * as aiService from './aiService.js';
import { sendMessage } from './whatsappService.js';

// This is the new "brain" for onboarding. It is NOT an AI tool.
export async function handleOnboardingStep(message, collections, user, conversation) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = user.userId;
    const messageText = message.text;

    // Use a state from the conversation document to track progress
    const currentState = conversation.state || 'onboarding_started';

    switch (currentState) {
        case 'onboarding_started':
            // The very first message from a new user.
            await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'onboarding_collecting_details' } });
            await sendMessage(senderId, "👋 Welcome to Fynax Bookkeeper! To get started, could you please tell me your *business name* and your *email address*?");
            break;

        case 'onboarding_collecting_details':
            // User has replied. Use AI to extract info.
            const details = await aiService.extractOnboardingDetails(messageText);

            const updates = {};
            if (details.businessName) updates.storeName = details.businessName;
            if (details.email) updates.email = details.email;

            if (Object.keys(updates).length > 0) {
                await usersCollection.updateOne({ userId: senderId }, { $set: updates });
                user = { ...user, ...updates }; // Update our local copy
            }

            // Now check what we have and what we still need
            if (user.storeName && user.email) {
                // We have both! Send the OTP.
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { otp, otpExpires, state: 'onboarding_verifying_otp' } });
                
                const emailSent = await sendOtpEmail(user.email, otp, user.storeName);
                if (emailSent) {
                    await sendMessage(senderId, `Perfect! 📧 A 6-digit verification code has been sent to *${user.email}*. Please check your inbox (and spam folder) and enter the code here to continue.`);
                } else {
                    await sendMessage(senderId, `I tried to send an email to *${user.email}*, but it failed. Please provide a correct email address.`);
                    await usersCollection.updateOne({ userId: senderId }, { $unset: { email: "" } }); // Clear the bad email
                }
            } else if (user.storeName) {
                await sendMessage(senderId, `Great, I have your business name as *${user.storeName}*. ✅\n\nNow, what's your *email address*?`);
            } else if (user.email) {
                 await sendMessage(senderId, `Thanks for the email! What is your *business name*?`);
            } else {
                await sendMessage(senderId, "I didn't quite catch that. Could you please provide your *business name* and *email address*?");
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
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'onboarding_needs_currency' }, $unset: { otp: "", otpExpires: "" } });
                await sendMessage(senderId, "Great news! Your email has been successfully verified. ✅\n\nNow, to complete your setup, what is your *primary currency*? (e.g., Naira, Dollars)");
            } else {
                await sendMessage(senderId, "That code is incorrect. Please check your email and try again.");
            }
            break;

        case 'onboarding_needs_currency':
            const currencyCode = await aiService.extractCurrency(messageText);
            if (currencyCode) {
                await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currencyCode.toUpperCase() } });
                await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } }); // ONBOARDING COMPLETE
                await sendOnboardingMenu(senderId); // Send the final button menu
            } else {
                await sendMessage(senderId, "I didn't quite catch that. Please tell me your currency (e.g., NGN, USD, GHS).");
            }
            break;
    }
}
