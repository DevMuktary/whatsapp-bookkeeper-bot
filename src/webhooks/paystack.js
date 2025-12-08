import express from 'express';
import crypto from 'crypto';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { updateUser, findUserById } from '../db/userService.js';
import { sendTextMessage } from '../api/whatsappService.js';
import { getDB } from '../db/connection.js'; // [NEW] Import DB access

const router = express.Router();

router.post('/', async (req, res) => {
    // 1. Verify Signature (Security)
    // Always verify before trusting the payload
    const hash = crypto.createHmac('sha512', config.paystack.webhookSecret)
                       .update(JSON.stringify(req.body))
                       .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        logger.warn('Invalid Paystack Webhook Signature. Request dropped.');
        return res.sendStatus(400);
    }

    // Acknowledge receipt immediately to stop Paystack from retrying 
    // (unless we crash, in which case they should retry)
    res.sendStatus(200);

    const event = req.body;

    try {
        if (event.event === 'charge.success') {
            const data = event.data;
            const reference = data.reference;
            
            // [CRITICAL FIX] Idempotency Check
            // Check if we have already processed this specific transaction reference
            const existingPayment = await getDB().collection('processed_payments').findOne({ reference });
            
            if (existingPayment) {
                logger.info(`Duplicate webhook received for reference: ${reference}. Ignoring.`);
                return;
            }

            const email = data.customer.email;
            const amountPaid = data.amount / 100; // Paystack sends kobo/cents
            const currency = data.currency;

            // 2. Find User (Metadata is best, fallback to email if needed in future)
            const userId = data.metadata?.userId;
            
            if (!userId) {
                logger.info(`Payment received from ${email} but no User ID in metadata. Amount: ${amountPaid}`);
                return;
            }

            const user = await findUserById(userId);
            if (!user) {
                logger.warn(`User ID ${userId} from payment metadata not found in DB.`);
                return;
            }

            // 3. CHECK THE AMOUNT (Prevent ₦50 fraud)
            const requiredNGN = config.paystack.prices.ngnMonthly;
            const requiredUSD = config.paystack.prices.usdMonthly;

            let validPayment = false;

            if (currency === 'NGN' && amountPaid >= requiredNGN) {
                validPayment = true;
            } else if (currency === 'USD' && amountPaid >= requiredUSD) {
                validPayment = true;
            }

            // [LOGIC] Log the attempt even if invalid amount, to prevent retry loops
            await getDB().collection('processed_payments').insertOne({
                reference,
                userId: user._id,
                amount: amountPaid,
                currency,
                status: validPayment ? 'PROCESSED' : 'INVALID_AMOUNT',
                processedAt: new Date()
            });

            if (!validPayment) {
                logger.warn(`User ${user.whatsappId} paid ${currency} ${amountPaid}, but required is ${requiredNGN}/${requiredUSD}. Subscription NOT renewed.`);
                await sendTextMessage(user.whatsappId, 
                    `⚠️ *Payment Alert*\n\nWe received a payment of *${currency} ${amountPaid.toLocaleString()}*, but the subscription cost is *${currency === 'NGN' ? '₦' + requiredNGN.toLocaleString() : '$' + requiredUSD}*.\n\nPlease contact support if this was a mistake.`
                );
                return; 
            }

            // 4. Update Subscription
            const now = new Date();
            let newExpiry = new Date();
            
            // If they are still active, add time to the END of their current expiry
            if (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now) {
                newExpiry = new Date(user.subscriptionExpiresAt);
            }
            
            newExpiry.setDate(newExpiry.getDate() + 30);

            await updateUser(user.whatsappId, {
                subscriptionStatus: 'ACTIVE',
                subscriptionExpiresAt: newExpiry,
                trialEndsAt: null
            });

            await sendTextMessage(user.whatsappId, 
                `✅ *Payment Received!*\n\nThank you! Your Fynax subscription has been renewed.\n\n📅 *Next Due Date:* ${newExpiry.toLocaleDateString()}\n\nKeep growing your business! 🚀`
            );
            
            logger.info(`Subscription extended for ${user.whatsappId} via Paystack ref ${reference}`);
        }
    } catch (error) {
        logger.error('Error processing Paystack webhook:', error);
    }
});

export default router;
