import { sendOtpEmail } from './notificationService.js';
import { sendOnboardingMenu } from './menuService.js';
import * as aiService from './aiService.js'; // We will call the AI from here
import { sendMessage } from './whatsappService.js';

// This is the new "brain" for onboarding. It's not an AI tool.
export async function handleOnboardingStep(message, collections, user, conversation) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = user.userId;
    const messageText = message.text;

    // --- Step 1: We don't have a business name or email yet ---
    if (!user.storeName || !user.email) {
        // Ask the AI to extract details from the user's message
        const details = await aiService.extractOnboardingDetails(messageText);

        const updates = {};
        if (details.businessName && !user.storeName) {
            updates.storeName = details.businessName;
        }
        if (details.email && !user.email) {
            updates.email = details.email;
        }

        // If we extracted something, update the user record
        if (Object.keys(updates).length > 0) {
            await usersCollection.updateOne({ userId: senderId }, { $set: updates });
            // Re-fetch the user object to get the latest data
            user = { ...user, ...updates };
        }

        // Now, check what's missing
        if (!user.storeName && !user.email) {
            await sendMessage(senderId, "👋 Welcome to Fynax Bookkeeper! To get started, could you please tell me your *business name* and your *email address*?");
        } else if (!user.storeName) {
            await sendMessage(senderId, `Thanks for the email! What is your *business name*?`);
        } else if (!user.email) {
            await sendMessage(senderId, `Great, I have your business name as *${user.storeName}*. ✅\n\nNow, what is your *email address* so I can send a verification code?`);
        } else {
            // We now have both! Send the OTP.
            console.log("--- DEBUG: Have both name and email. Sending OTP now. ---");
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
            await conversationsCollection.updateOne({ userId: senderId }, { $set: { otp, otpExpires, state: 'onboarding_verifying_otp' } });
            
            const emailSent = await sendOtpEmail(user.email, otp, user.storeName);

            if (emailSent) {
                await sendMessage(senderId, `Perfect! 📧 A 6-digit verification code has been sent to *${user.email}*. Please check your inbox and enter the code here to continue.`);
            } else {
                await sendMessage(senderId, `I tried to send an email to *${user.email}*, but it failed. Please provide a correct email address.`);
                // Clear the bad email so we can ask again
                await usersCollection.updateOne({ userId: senderId }, { $unset: { email: "" } });
            }
        }
        return;
    }

    // --- Step 2: We have details, now we're verifying OTP ---
    if (!user.emailVerified) {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        const userOTP = messageText.trim();

        if (conversation && conversation.otp && conversation.otp === userOTP) {
            if (new Date() < new Date(conversation.otpExpires)) {
                // OTP is correct and not expired
                await usersCollection.updateOne({ userId: senderId }, { $set: { emailVerified: true } });
                await conversationsCollection.updateOne({ userId: senderId }, { $unset: { otp: "", otpExpires: "" }, $set: { state: 'onboarding_needs_currency' } });
                await sendMessage(senderId, "Great news! Your email has been successfully verified. ✅\n\nNow, to complete your setup, what is your *primary currency*? (e.g., Naira, Dollars)");
            } else {
                await conversationsCollection.updateOne({ userId: senderId }, { $unset: { otp: "", otpExpires: "" } });
                await sendMessage(senderId, "That code has expired. Let's get your details again to send a new one.");
                // Reset the user's details to restart the OTP process
                 await usersCollection.updateOne({ userId: senderId }, { $unset: { email: "" } });
            }
        } else {
            await sendMessage(senderId, "That code is incorrect. Please check your email and try again.");
        }
        return;
    }

    // --- Step 3: We have a verified email, now we need currency ---
    if (!user.currency) {
        const currencyCode = await aiService.extractCurrency(messageText);
        if (currencyCode) {
            await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currencyCode } });
            await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } }); // ONBOARDING COMPLETE
            await sendOnboardingMenu(senderId);
        } else {
            await sendMessage(senderId, "I didn't quite catch that. Please tell me your currency (e.g., NGN, USD, GHS).");
        }
        return;
    }
}
