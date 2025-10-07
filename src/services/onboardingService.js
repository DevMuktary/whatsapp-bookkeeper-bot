import { sendOtpEmail } from './notificationService.js';
import { sendOnboardingMenu } from './menuService.js';

/**
 * --- BOT TOOL: Onboard a New User ---
 * Saves user details, generates an OTP, and sends it via email.
 */
export async function onboardUser(args, collections, senderId) {
    const { usersCollection, conversationsCollection } = collections;
    const { businessName, email } = args;

    // Basic email validation
    if (!email || !email.includes('@')) {
        return { success: false, message: "That doesn't look like a valid email. Please provide a correct email address." };
    }

    try {
        // Generate a 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        // Set OTP to expire in 10 minutes
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

        // Save business name and email to the user
        await usersCollection.updateOne({ userId: senderId }, { $set: { storeName: businessName, email: email, emailVerified: false } });

        // Save the OTP and its expiry to the user's conversation
        await conversationsCollection.updateOne({ userId: senderId }, { $set: { otp: otp, otpExpires: otpExpires } });

        // Send the OTP email via Brevo
        const emailSent = await sendOtpEmail(email, otp, businessName);

        if (!emailSent) {
            return { success: false, message: "I couldn't send the verification email. Please check the address and try again." };
        }

        // This message is for the AI, which will then use it to formulate a user-facing response.
        return { success: true, message: `An OTP has been sent to ${email}.` };
    } catch (error) {
        console.error("Error in onboardUser tool:", error);
        return { success: false, message: "An internal error occurred while setting up your account." };
    }
}

/**
 * --- BOT TOOL: Verify Email OTP ---
 * Verifies the OTP provided by the user.
 */
export async function verifyEmailOTP(args, collections, senderId) {
    const { usersCollection, conversationsCollection } = collections;
    const { otp } = args;

    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });

        if (!conversation || !conversation.otp || !conversation.otpExpires) {
            return { success: false, message: "It looks like a verification code was not sent. Please provide your email address again so I can send one." };
        }

        if (new Date() > new Date(conversation.otpExpires)) {
            // Unset the expired OTP
            await conversationsCollection.updateOne({ userId: senderId }, { $unset: { otp: "", otpExpires: "" } });
            return { success: false, message: "That code has expired. Please provide your email address again so I can send a new one." };
        }

        if (conversation.otp === otp.trim()) {
            // OTP is correct
            await usersCollection.updateOne({ userId: senderId }, { $set: { emailVerified: true } });
            // Clear the OTP
            await conversationsCollection.updateOne({ userId: senderId }, { $unset: { otp: "", otpExpires: "" } });
            return { success: true, message: "Email verified successfully!" };
        } else {
            // Incorrect OTP
            return { success: false, message: "That code is incorrect. Please double-check your email and try again." };
        }
    } catch (error) {
        console.error("Error in verifyEmailOTP tool:", error);
        return { success: false, message: "An internal error occurred during verification." };
    }
}

/**
 * --- BOT TOOL: Set User Currency ---
 * Sets the currency for the user's account.
 */
export async function setCurrency(args, collections, senderId) {
    const { usersCollection, conversationsCollection } = collections;
    const { currencyCode } = args;

    try {
        await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currencyCode.toUpperCase() } });
        // Onboarding is now complete, clear the onboarding state
        await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } });
        
        // Send the interactive welcome menu
        await sendOnboardingMenu(senderId);
        
        // This message is for the AI's context. The user will see the button menu, not this text.
        return { success: true, message: `Onboarding complete. Welcome menu sent.` };
    } catch (error) {
        console.error("Error in setCurrency tool:", error);
        return { success: false, message: "An error occurred while setting your currency." };
    }
}
