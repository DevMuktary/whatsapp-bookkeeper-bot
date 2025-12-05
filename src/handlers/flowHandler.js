import { updateUser, updateUserState, findOrCreateUser } from '../db/userService.js';
import { createBankAccount } from '../db/bankService.js';
import { sendOtp } from '../services/emailService.js';
import { sendTextMessage, sendMainMenu } from '../api/whatsappService.js';
import { USER_STATES } from '../utils/constants.js';
import { parsePrice } from '../utils/helpers.js'; // Assuming helpers.js exists as discussed
import logger from '../utils/logger.js';

export async function handleFlowResponse(message) {
    const whatsappId = message.from;
    let responseJson = {};
    
    try {
        responseJson = JSON.parse(message.interactive.nfm_reply.response_json);
        logger.info(`Flow Response from ${whatsappId}:`, JSON.stringify(responseJson));
    } catch (parseError) {
        logger.error("Failed to parse flow response JSON", parseError);
        return;
    }

    // Auto-detect Screen
    let screen = responseJson.screen;
    if (!screen) {
        if (responseJson.business_name && responseJson.email) screen = 'SIGN_UP_SCREEN';
        else if (responseJson.bank_name) screen = 'ADD_BANK_SCREEN';
    }

    try {
        const user = await findOrCreateUser(whatsappId);

        // 1. ONBOARDING
        if (screen === 'SIGN_UP_SCREEN') {
            const { business_name, email, currency } = responseJson;
            await sendTextMessage(whatsappId, "Creating your account... 🔄");
            
            await updateUser(whatsappId, {
                businessName: business_name,
                email: email,
                currency: currency || 'NGN', 
                isEmailVerified: false 
            });

            // Trigger OTP
            const otp = await sendOtp(email, business_name);
            await updateUser(whatsappId, { otp, otpExpires: new Date(Date.now() + 600000) });
            await updateUserState(whatsappId, USER_STATES.ONBOARDING_AWAIT_OTP);
            
            await sendTextMessage(whatsappId, `✅ Account created for **${business_name}**!\n\nI sent a verification code to ${email}. Please enter it below.`);
        
        // 2. ADD BANK ACCOUNT
        } else if (screen === 'ADD_BANK_SCREEN') {
            const { bank_name, opening_balance } = responseJson;
            const balance = parsePrice(opening_balance);
            
            if (isNaN(balance)) {
                await sendTextMessage(whatsappId, "Invalid balance provided. Please try again.");
                return;
            }

            if (user.role === 'STAFF') {
                await sendTextMessage(whatsappId, "⛔ Staff cannot add bank accounts.");
                return;
            }

            // We need to create it for the Owner if it's the owner, or link it correctly.
            // Assuming 'user' is the correct context here. 
            await createBankAccount(user._id, bank_name, balance);
            
            await sendTextMessage(whatsappId, `✅ Bank Account **${bank_name}** added with balance ${user.currency || 'NGN'} ${balance.toLocaleString()}.`);
            await updateUserState(whatsappId, USER_STATES.IDLE);
            await sendMainMenu(whatsappId);
        } else {
            await sendTextMessage(whatsappId, "I received your data, but I'm not sure which form it belongs to.");
        }

    } catch (error) {
        logger.error("Flow Error:", error);
        await sendTextMessage(whatsappId, "Error processing your request. Please try again.");
    }
}

export async function handleOtpVerification(user, text) {
    const inputOtp = text.trim();
    if (user.otp === inputOtp) {
        await updateUser(user.whatsappId, { isEmailVerified: true }); 
        await updateUserState(user.whatsappId, USER_STATES.IDLE);
        await sendTextMessage(user.whatsappId, "✅ Email verified! Your account is ready.");
        await sendMainMenu(user.whatsappId);
    } else {
        await sendTextMessage(user.whatsappId, "❌ Invalid code. Please check your email and try again.");
    }
}
