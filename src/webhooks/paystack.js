import express from 'express';
import crypto from 'crypto';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { updateUser, findUserById } from '../db/userService.js';
import { sendTextMessage } from '../api/whatsappService.js';

const router = express.Router();

router.post('/', async (req, res) => {
    // 1. Verify Signature (Security)
    const hash = crypto.createHmac('sha512', config.paystack.webhookSecret)
                       .update(JSON.stringify(req.body))
                       .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        logger.warn('Invalid Paystack Webhook Signature. Request dropped.');
        return res.sendStatus(400);
    }

    res.sendStatus(200); // Acknowledge receipt instantly

    const event = req.body;

    try {
        if (event.event === 'charge.success') {
            const data = event.data;
            const email = data.customer.email;
            
            // We find user by Email (most reliable for webhooks)
            // Ideally, we stored the userId in metadata, but email is a good fallback
            // In a real app, we might need a dedicated findUserByEmail function, 
            // but for now, we rely on the metadata we sent or the dedicated account logic.
            
            // Note: Since we don't have findUserByEmail exported, let's use the DB directly here or rely on metadata
            // Let's assume we can trust the metadata we sent in `initializePayment`
            
            let userId = data.metadata?.userId;
            
            // For Dedicated Accounts, metadata might be empty, so we need to find user by customer_code
            if (!userId) {
                // This part would require a db lookup by email or customer code.
                // For simplicity in this batch, we assume direct link or implement a quick lookup later.
                // Let's assume we implement `findUserByEmail` in userService in future, 
                // but for now, we log it if we can't find ID.
                logger.info(`Payment received for ${email}. Amount: ${data.amount / 100}`);
                // TODO: In Batch 2, we can refine this lookup if needed.
                return;
            }

            const user = await findUserById(userId);
            if (!user) return;

            // Calculate New Expiry
            // Rule: If currently active, add 30 days to existing expiry. If expired, start from today.
            const now = new Date();
            let newExpiry = new Date();
            
            if (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now) {
                newExpiry = new Date(user.subscriptionExpiresAt); // Start from existing end date
            }
            
            newExpiry.setDate(newExpiry.getDate() + 30); // Add 30 Days

            await updateUser(user.whatsappId, {
                subscriptionStatus: 'ACTIVE',
                subscriptionExpiresAt: newExpiry,
                trialEndsAt: null // Remove trial flag
            });

            await sendTextMessage(user.whatsappId, 
                `✅ **Payment Received!**\n\nThank you! Your Fynax Monthly subscription has been renewed.\n\n📅 **Next Due Date:** ${newExpiry.toLocaleDateString()}\n\nKeep growing your business! 🚀`
            );
        }
    } catch (error) {
        logger.error('Error processing Paystack webhook:', error);
    }
});

export default router;
