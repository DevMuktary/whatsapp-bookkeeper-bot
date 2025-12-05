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

/**
 * Creates a Dedicated Virtual Account (NUBAN) for Nigerian users.
 */
export async function createDedicatedAccount(user) {
    try {
        if (user.dedicatedAccount) return user.dedicatedAccount;

        // 1. Create Customer in Paystack if not exists
        let customerCode = user.paystackCustomerCode;
        if (!customerCode) {
            const customerRes = await paystackClient.post('/customer', {
                email: user.email,
                first_name: user.businessName || 'Fynax User',
                last_name: user.whatsappId,
                phone: user.whatsappId
            });
            customerCode = customerRes.data.data.customer_code;
            await updateUser(user.whatsappId, { paystackCustomerCode: customerCode });
        }

        // 2. Request Dedicated Account
        const accountRes = await paystackClient.post('/dedicated_account', {
            customer: customerCode,
            preferred_bank: "wema-bank" // Using Wema as default provider
        });

        const accountData = {
            bankName: accountRes.data.data.bank.name,
            accountNumber: accountRes.data.data.account_number,
            accountName: accountRes.data.data.account_name
        };

        await updateUser(user.whatsappId, { dedicatedAccount: accountData });
        return accountData;

    } catch (error) {
        logger.error(`Error creating dedicated account for ${user.whatsappId}:`, error.response?.data || error.message);
        throw new Error("Could not generate account number.");
    }
}

/**
 * Generates a Payment Link for International Users (USD).
 */
export async function initializePayment(user, currency = 'USD') {
    try {
        const amount = currency === 'NGN' 
            ? config.paystack.prices.ngnMonthly * 100 
            : config.paystack.prices.usdMonthly * 100;

        const response = await paystackClient.post('/transaction/initialize', {
            email: user.email,
            amount: amount,
            currency: currency,
            reference: `FYNAX_${user._id}_${Date.now()}`,
            callback_url: 'https://wa.me/' + config.whatsapp.phoneNumberId, // Redirects back to WhatsApp
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
