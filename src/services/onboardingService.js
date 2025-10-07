import { sendOtpEmail } from './notificationService.js';
import { sendOnboardingMenu } from './menuService.js'; // <-- NEW IMPORT

/**
 * --- BOT TOOL: Onboard a New User ---
 */
export async function onboardUser(args, collections, senderId) {
    const { usersCollection, conversationsCollection } = collections;
    const { businessName, email } = args;

    if (!email || !email.includes('@')) {
        return { success: false, message: "That doesn't look like a valid email. Please provide a correct email address." };
    }

    try {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

        await usersCollection.updateOne({ userId: senderId }, { $set: { storeName: businessName, email: email, emailVerified: false } });
        await conversationsCollection.updateOne({ userId: senderId }, { $set: { otp: otp, otpExpires: otpExpires } });

        const emailSent = await sendOtpEmail(email, otp, businessName);

        if (!emailSent) {
            return { success: false, message: "I couldn't send the verification email. Please check the address and try again." };
        }

        return { success: true, message: `Great! I've sent a verification code to ${email}. Please send the code back to me here.` };
    } catch (error) {
        console.error("Error in onboardUser tool:", error);
        return { success: false, message: "An internal error occurred while setting up your account." };
    }
}

/**
 * --- BOT TOOL: Verify Email OTP ---
 */
export async function verifyEmailOTP(args, collections, senderId) {
    const { usersCollection, conversationsCollection } = collections;
    const { otp } = args;

    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        if (!conversation.otp || !conversation.otpExpires) {
            return { success: false, message: "It looks like an OTP was not sent. Let's try again." };
        }
        if (new Date() > new Date(conversation.otpExpires)) {
            await conversationsCollection.updateOne({ userId: senderId }, { $unset: { otp: "", otpExpires: "" } });
            return { success: false, message: "That code has expired. Let's send a new one." };
        }
        if (conversation.otp === otp.trim()) {
            await usersCollection.updateOne({ userId: senderId }, { $set: { emailVerified: true } });
            await conversationsCollection.updateOne({ userId: senderId }, { $unset: { otp: "", otpExpires: "" } });
            return { success: true, message: "Email verified successfully!" };
        } else {
            return { success: false, message: "That code is incorrect. Please check your email and try again." };
        }
    } catch (error) {
        console.error("Error in verifyEmailOTP tool:", error);
        return { success: false, message: "An internal error occurred during verification." };
    }
}

/**
 * --- BOT TOOL: Set User Currency ---
 */
export async function setCurrency(args, collections, senderId) {
    const { usersCollection, conversationsCollection } = collections;
    const { currencyCode } = args;

    try {
        await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currencyCode.toUpperCase() } });
        await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } });
        
        // --- THIS IS THE CHANGE ---
        // Instead of returning text, we send the interactive menu.
        await sendOnboardingMenu(senderId);
        
        // Return a result for the AI, but it won't be sent to the user.
        return { success: true, message: `Onboarding complete. Welcome menu sent.` };
    } catch (error) {
        console.error("Error in setCurrency tool:", error);
        return { success: false, message: "An error occurred while setting your currency." };
    }
}
