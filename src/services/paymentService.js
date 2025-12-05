import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { updateUser } from '../db/userService.js';

const PAYSTACK_URL = 'https://api.paystack.co';

const paystackClient = axios.create({
    baseURL: PAYSTACK_URL,
    headers: {
        Authorization: `Bearer ${config.paystack.secretKey}`,
        'Content-Type': 'application/json'
    }
});

// Helper to create a customer on Paystack
async function createPaystackCustomer(user) {
    try {
        const customerRes = await paystackClient.post('/customer', {
            email: user.email,
            first_name: user.businessName || 'Fynax User',
            last_name: user.whatsappId,
            phone: user.whatsappId
        });
        const newCode = customerRes.data.data.customer_code;
        
        // Save the new code to DB immediately
        await updateUser(user.whatsappId, { paystackCustomerCode: newCode });
        return newCode;
    } catch (error) {
        logger.error(`Failed to create Paystack customer for ${user.whatsappId}`, error.message);
        throw error;
    }
}

/**
 * Creates a Dedicated Virtual Account (NUBAN) for Nigerian users.
 * Includes "Self-Healing" logic for invalid customer codes.
 */
export async function createDedicatedAccount(user) {
    try {
        if (user.dedicatedAccount) return user.dedicatedAccount;

        let customerCode = user.paystackCustomerCode;

        // 1. If no code exists, create one
        if (!customerCode) {
            customerCode = await createPaystackCustomer(user);
        }

        // 2. Request Dedicated Account (with Retry Logic)
        try {
            const accountRes = await paystackClient.post('/dedicated_account', {
                customer: customerCode,
                preferred_bank: "wema-bank"
            });

            const accountData = {
                bankName: accountRes.data.data.bank.name,
                accountNumber: accountRes.data.data.account_number,
                accountName: accountRes.data.data.account_name
            };

            await updateUser(user.whatsappId, { dedicatedAccount: accountData });
            return accountData;

        } catch (apiError) {
            // [SELF-HEALING FIX]
            // If Paystack says "Customer not found", it means our DB code is stale.
            // We create a NEW customer and retry ONCE.
            if (apiError.response?.data?.message?.includes('Customer not found') || 
                apiError.response?.data?.code === 'customer_not_found') {
                
                logger.warn(`Stale Customer Code detected for ${user.whatsappId}. Regenerating...`);
                
                // Create New Customer
                const newCode = await createPaystackCustomer(user);
                
                // Retry Account Creation
                const retryRes = await paystackClient.post('/dedicated_account', {
                    customer: newCode,
                    preferred_bank: "wema-bank"
                });

                const retryAccountData = {
                    bankName: retryRes.data.data.bank.name,
                    accountNumber: retryRes.data.data.account_number,
                    accountName: retryRes.data.data.account_name
                };

                await updateUser(user.whatsappId, { dedicatedAccount: retryAccountData });
                return retryAccountData;
            }

            throw apiError; // Throw other errors (like network issues)
        }

    } catch (error) {
        logger.error(`Error creating dedicated account for ${user.whatsappId}:`, error.response?.data || error.message);
        throw new Error("Could not generate account number. Please try again.");
    }
}

/**
 * Generates a Payment Link.
 * [FIX] Defaults to NGN if USD fails, to prevent "Currency not supported" crashes.
 */
export async function initializePayment(user, preferredCurrency = 'USD') {
    try {
        // [FIX] Force NGN if your account is not yet approved for USD.
        // Change 'false' to 'true' once you are approved for International Payments.
        const IS_USD_ENABLED = false; 

        const currency = IS_USD_ENABLED ? preferredCurrency : 'NGN';
        
        // Calculate amount (7500 NGN or equivalent USD conversion if needed)
        // If IS_USD_ENABLED is false, we default International users to pay NGN equivalent (~8000 for $5)
        const amount = currency === 'NGN' 
            ? config.paystack.prices.ngnMonthly * 100 
            : config.paystack.prices.usdMonthly * 100;

        const response = await paystackClient.post('/transaction/initialize', {
            email: user.email,
            amount: amount,
            currency: currency,
            reference: `FYNAX_${user._id}_${Date.now()}`,
            callback_url: 'https://wa.me/' + config.whatsapp.phoneNumberId,
            metadata: {
                userId: user._id,
                whatsappId: user.whatsappId,
                type: 'SUBSCRIPTION'
            }
        });

        return response.data.data.authorization_url;
    } catch (error) {
        logger.error(`Error initializing payment for ${user.whatsappId}:`, error.response?.data || error.message);
        throw new Error("Could not generate payment link.");
    }
}
