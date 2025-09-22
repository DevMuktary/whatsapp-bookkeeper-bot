import bcrypt from 'bcrypt';
import { normalizePhone } from '../utils/helpers.js'; // <-- NEW IMPORT
const SALT_ROUNDS = 10;

// --- THE normalizePhone FUNCTION IS GONE FROM HERE ---

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
    if (!targetJid) {
        return await sock.sendMessage(adminUser.userId, { text: `Invalid phone number format.` });
    }

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
    if (!targetJid) {
        return await sock.sendMessage(adminUser.userId, { text: `Invalid phone number format.` });
    }

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
    if (!targetJid) {
        return await sock.sendMessage(adminUser.userId, { text: `Invalid phone number format.` });
    }

    const targetUser = await usersCollection.findOne({ userId: targetJid });

    if (!targetUser) {
        return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` });
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await usersCollection.updateOne({ userId: targetJid }, { $set: { websitePassword: hashedPassword } });

    await sock.sendMessage(adminUser.userId, { text: `Password for ${targetUser.userId} has been changed.` });
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
 */
export async function handleAdminCommand(sock, messageText, collections, adminUser) {
    const parts = messageText.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

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
