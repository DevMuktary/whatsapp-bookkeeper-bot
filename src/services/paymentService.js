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

async function createPaystackCustomer(user) {
    try {
        const customerRes = await paystackClient.post('/customer', {
            email: user.email,
            first_name: user.businessName || 'Fynax User',
            last_name: String(user.whatsappId), 
            phone: String(user.whatsappId)
        });
        const newCode = customerRes.data.data.customer_code;
        await updateUser(user.whatsappId, { paystackCustomerCode: newCode });
        return newCode;
    } catch (error) {
        logger.error(`Failed to create Paystack customer for ${user.whatsappId}`, error.message);
        throw error;
    }
}

async function updatePaystackCustomer(customerCode, user) {
    try {
        await paystackClient.put(`/customer/${customerCode}`, {
            first_name: user.businessName || 'Fynax User',
            last_name: String(user.whatsappId),
            phone: String(user.whatsappId)
        });
        logger.info(`Updated Paystack profile for ${customerCode}`);
    } catch (error) {
        logger.warn(`Failed to update Paystack profile: ${error.message}`);
    }
}

export async function createDedicatedAccount(user) {
    try {
        if (user.dedicatedAccount) return user.dedicatedAccount;

        let customerCode = user.paystackCustomerCode;

        if (!customerCode) {
            customerCode = await createPaystackCustomer(user);
        }

        const createAccountReq = async (code) => {
            const res = await paystackClient.post('/dedicated_account', {
                customer: code,
                // [FIX] Removed 'preferred_bank' so Paystack chooses the best one
            });
            return {
                bankName: res.data.data.bank.name,
                accountNumber: res.data.data.account_number,
                accountName: res.data.data.account_name
            };
        };

        try {
            const accountData = await createAccountReq(customerCode);
            await updateUser(user.whatsappId, { dedicatedAccount: accountData });
            return accountData;

        } catch (apiError) {
            const msg = apiError.response?.data?.message || '';
            const codeError = apiError.response?.data?.code || '';

            if (codeError === 'validation_error' || msg.includes('required') || msg.includes('last_name')) {
                logger.warn(`Incomplete Profile for ${user.whatsappId}. Updating and Retrying...`);
                await updatePaystackCustomer(customerCode, user);
                const retryData = await createAccountReq(customerCode);
                await updateUser(user.whatsappId, { dedicatedAccount: retryData });
                return retryData;
            }

            if (msg.includes('Customer not found') || codeError === 'customer_not_found') {
                logger.warn(`Stale Customer Code for ${user.whatsappId}. Regenerating...`);
                const newCode = await createPaystackCustomer(user);
                const retryData = await createAccountReq(newCode);
                await updateUser(user.whatsappId, { dedicatedAccount: retryData });
                return retryData;
            }

            throw apiError; 
        }

    } catch (error) {
        logger.error(`Error creating dedicated account for ${user.whatsappId}:`, error.response?.data || error.message);
        throw new Error("Could not generate account number. Please try again.");
    }
}

export async function initializePayment(user, preferredCurrency = 'USD') {
    try {
        const IS_USD_ENABLED = false; 
        const currency = IS_USD_ENABLED ? preferredCurrency : 'NGN';
        
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
