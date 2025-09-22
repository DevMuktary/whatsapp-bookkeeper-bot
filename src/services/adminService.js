import bcrypt from 'bcrypt';
const SALT_ROUNDS = 10;

/**
 * Normalizes a phone number to the format used in the DB (e.g., 234810...).
 * @param {string} phone - The input phone number (e.g., +234810..., 0810...)
 * @returns {string} - The normalized JID-like number.
 */
function normalizePhone(phone) {
    let normalized = phone.replace(/[^0-9]/g, ''); // Remove non-numeric chars
    if (normalized.startsWith('0')) {
        normalized = '234' + normalized.substring(1); // Assume 234 for local numbers
    }
    // Add other rules here if needed, e.g., for other country codes
    return `${normalized}@s.whatsapp.net`;
}

/**
 * --- Admin Function: Block a User ---
 */
async function blockUser(args, collections, sock, adminUser) {
    const { usersCollection } = collections;
    const phoneToBlock = args[0];
    if (!phoneToBlock) {
        return await sock.sendMessage(adminUser.userId, { text: "Usage: /block [phone_number]" });
    }

    const targetJid = normalizePhone(phoneToBlock);
    const targetUser = await usersCollection.findOne({ userId: targetJid });

    if (!targetUser) {
        return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` });
    }
    if (targetUser.role === 'admin') {
        return await sock.sendMessage(adminUser.userId, { text: `Cannot block another admin.` });
    }

    await usersCollection.updateOne({ userId: targetJid }, { $set: { isBlocked: true } });
    await sock.sendMessage(adminUser.userId, { text: `User ${targetUser.userId} has been blocked.` });
}

/**
 * --- Admin Function: Unblock a User ---
 */
async function unblockUser(args, collections, sock, adminUser) {
    const { usersCollection } = collections;
    const phoneToUnblock = args[0];
    if (!phoneToUnblock) {
        return await sock.sendMessage(adminUser.userId, { text: "Usage: /unblock [phone_number]" });
    }

    const targetJid = normalizePhone(phoneToUnblock);
    const targetUser = await usersCollection.findOne({ userId: targetJid });

    if (!targetUser) {
        return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` });
    }

    await usersCollection.updateOne({ userId: targetJid }, { $set: { isBlocked: false } });
    await sock.sendMessage(adminUser.userId, { text: `User ${targetUser.userId} has been unblocked.` });
}

/**
 * --- Admin Function: Change a User's Web Password ---
 */
async function setPassword(args, collections, sock, adminUser) {
    const { usersCollection } = collections;
    const phoneToSet = args[0];
    const newPassword = args[1];

    if (!phoneToSet || !newPassword) {
        return await sock.sendMessage(adminUser.userId, { text: "Usage: /setpass [phone_number] [new_password]" });
    }
    if (newPassword.length < 6) {
        return await sock.sendMessage(adminUser.userId, { text: "Password must be at least 6 characters." });
    }

    const targetJid = normalizePhone(phoneToSet);
    const targetUser = await usersCollection.findOne({ userId: targetJid });

    if (!targetUser) {
        return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` });
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await usersCollection.updateOne({ userId: targetJid }, { $set: { websitePassword: hashedPassword } });

    await sock.sendMessage(adminUser.userId, { text: `Password for ${targetUser.userId} has been changed.` });
    // Notify the user as well
    await sock.sendMessage(targetJid, { text: `An admin has reset your web password. Your new password is: \`${newPassword}\`` });
}

/**
 * --- Admin Function: List available commands ---
 */
async function showHelp(sock, adminUser) {
    const helpText = `*Fynax Admin Panel* 🔑\n\nAvailable commands:\n\n*/block [phone_number]*\n_Stops a user from using the bot._\n\n*/unblock [phone_number]*\n_Re-enables a user._\n\n*/setpass [phone_number] [new_password]*\n_Resets a user's web password._\n\n*/help*\n_Shows this message._`;
    await sock.sendMessage(adminUser.userId, { text: helpText });
}


/**
 * --- Main Admin Command Router ---
 * This function is called by messageHandler
 */
export async function handleAdminCommand(sock, messageText, collections, adminUser) {
    const parts = messageText.split(' ');
    const command = parts[0].toLowerCase(); // e.g., "/block"
    const args = parts.slice(1); // e.g., ["0810..."]

    switch (command) {
        case '/block':
            await blockUser(args, collections, sock, adminUser);
            break;
        case '/unblock':
            await unblockUser(args, collections, sock, adminUser);
            break;
        case '/setpass':
            await setPassword(args, collections, sock, adminUser);
            break;
        case '/help':
            await showHelp(sock, adminUser);
            break;
        default:
            await sock.sendMessage(adminUser.userId, { text: `Unknown command: ${command}\nType /help for a list of commands.` });
    }
}
