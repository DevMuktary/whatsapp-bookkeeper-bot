import { getSystemStats, getAllUsers, findUserByPhone, updateUser } from '../db/userService.js';
import { sendTextMessage } from '../api/whatsappService.js';
import logger from '../utils/logger.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function handleAdminCommand(adminUser, text) {
    const parts = text.split(' ');
    // parts[0] is "!admin"
    // parts[1] is the action (stats, gift)
    const action = parts[1] ? parts[1].toLowerCase() : null; 

    try {
        // 1. STATS COMMAND
        if (action === 'stats') {
            await sendTextMessage(adminUser.whatsappId, "📊 Calculating system stats...");
            
            const stats = await getSystemStats();
            
            const report = `🚀 *Fynax Admin Report*\n\n` +
                           `👥 Total Users: *${stats.totalUsers}*\n` +
                           `🟢 Active Subs: *${stats.activeSubs}*\n` +
                           `🔵 On Trial: *${stats.trials}*\n` +
                           `💰 Est. Revenue (Active): *₦${stats.estimatedRevenue.toLocaleString()}*\n\n` +
                           `System is running smoothly.`;
            
            await sendTextMessage(adminUser.whatsappId, report);
            return;
        }

        // 2. GIFT COMMAND (!admin gift 23480... 30)
        if (action === 'gift') {
            const targetPhone = parts[2];
            const days = parts[3] ? parseInt(parts[3]) : 0;

            if (!targetPhone || !days || isNaN(days)) {
                await sendTextMessage(adminUser.whatsappId, "❌ Usage: !admin gift [phone] [days]");
                return;
            }

            const targetUser = await findUserByPhone(targetPhone);
            if (!targetUser) {
                await sendTextMessage(adminUser.whatsappId, "❌ User not found.");
                return;
            }

            const now = new Date();
            let newExpiry = new Date();
            
            // Check if they already have an active date
            if (targetUser.subscriptionExpiresAt && new Date(targetUser.subscriptionExpiresAt) > now) {
                newExpiry = new Date(targetUser.subscriptionExpiresAt);
            }
            
            newExpiry.setDate(newExpiry.getDate() + days);

            await updateUser(targetUser.whatsappId, {
                subscriptionStatus: 'ACTIVE',
                subscriptionExpiresAt: newExpiry,
                trialEndsAt: null
            });

            await sendTextMessage(adminUser.whatsappId, `✅ Added ${days} days to ${targetPhone}.`);
            await sendTextMessage(targetPhone, `🎁 *Gift Received!*\n\nThe Admin has extended your subscription by ${days} days.\nNew Expiry: ${newExpiry.toLocaleDateString()}`);
            return;
        }

        // Default if unknown command
        await sendTextMessage(adminUser.whatsappId, "⚠️ Unknown Admin Command.\n\nTry:\n!admin stats\n!admin gift [phone] [days]");

    } catch (error) {
        logger.error("Admin Command Failed:", error);
        await sendTextMessage(adminUser.whatsappId, "❌ Command failed. Check logs.");
    }
}

export async function handleBroadcast(adminUser, text) {
    const messageContent = text.replace('!broadcast', '').trim();
    
    if (messageContent.length < 5) {
        await sendTextMessage(adminUser.whatsappId, "❌ Message too short to broadcast.");
        return;
    }

    await sendTextMessage(adminUser.whatsappId, "📢 Starting broadcast... This may take time.");

    const users = await getAllUsers();
    let count = 0;

    for (const user of users) {
        try {
            await sendTextMessage(user.whatsappId, `📢 *Announcement*\n\n${messageContent}`);
            count++;
            await sleep(100); 
        } catch (e) {
            logger.warn(`Failed to broadcast to ${user.whatsappId}`);
        }
    }

    await sendTextMessage(adminUser.whatsappId, `✅ Broadcast complete. Sent to ${count} users.`);
}
