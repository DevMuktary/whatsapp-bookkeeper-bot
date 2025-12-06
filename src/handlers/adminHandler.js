import { getSystemStats, getAllUsers, findUserByPhone, updateUser } from '../db/userService.js';
import { sendTextMessage } from '../api/whatsappService.js';
import logger from '../utils/logger.js';

// Helper to pause execution (avoid spamming WhatsApp API)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function handleAdminCommand(adminUser, text) {
    const parts = text.split(' ');
    const command = parts[0].toLowerCase(); // e.g., !admin
    const action = parts[1]?.toLowerCase(); // e.g., stats, gift

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
            const days = parseInt(parts[3]);

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
            // Extend existing or start new
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

        await sendTextMessage(adminUser.whatsappId, "⚠️ Unknown Admin Command.\nTry: stats, gift");

    } catch (error) {
        logger.error("Admin Command Failed:", error);
        await sendTextMessage(adminUser.whatsappId, "❌ Command failed. Check logs.");
    }
}

export async function handleBroadcast(adminUser, text) {
    // Text format: "!broadcast Hello everyone..."
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
            await sleep(100); // 100ms delay to be safe
        } catch (e) {
            logger.warn(`Failed to broadcast to ${user.whatsappId}`);
        }
    }

    await sendTextMessage(adminUser.whatsappId, `✅ Broadcast complete. Sent to ${count} users.`);
}
