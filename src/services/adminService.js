import bcrypt from 'bcrypt';
import { normalizePhone } from '../utils/helpers.js';
import * as reportService from './reportService.js';
import archiver from 'archiver';

const SALT_ROUNDS = 10;

// ==================================================================
// --- API ENDPOINT LOGIC ---
// ==================================================================

/**
 * --- API Endpoint: Get All Users (for Admin) ---
 */
export async function getAllUsers(req, res, collections) {
    const { usersCollection } = collections;
    try {
        const users = await usersCollection.find({}, { 
            projection: { websitePassword: 0 } 
        }).toArray();
        res.status(200).json(users);
    } catch (error) {
        console.error("Error in getAllUsers:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}

/**
 * --- API Endpoint: Get a Report for a Specific User ---
 */
export async function getReportForUser(req, res, collections) {
    // ... (This function is unchanged)
    const { usersCollection } = collections;
    const { userId, reportType } = req.params;
    try {
        const user = await usersCollection.findOne({ userId: userId });
        if (!user) { return res.status(404).json({ message: "User not found." }); }
        let pdfBuffer;
        let fileName = `${reportType}_report_${user.storeName || userId}.pdf`;
        switch (reportType.toLowerCase()) {
            case 'transactions':
                pdfBuffer = await reportService.getTransactionReportAsBuffer(collections, userId);
                fileName = `Financial_Report_${user.storeName || userId}.pdf`;
                break;
            case 'inventory':
                pdfBuffer = await reportService.getInventoryReportAsBuffer(collections, userId);
                fileName = `Inventory_Report_${user.storeName || userId}.pdf`;
                break;
            case 'pnl':
                pdfBuffer = await reportService.getPnLReportAsBuffer(collections, userId);
                fileName = `P&L_Report_${user.storeName || userId}.pdf`;
                break;
            default:
                return res.status(400).json({ message: "Invalid report type. Use 'transactions', 'inventory', or 'pnl'." });
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error(`Error in getReportForUser (${reportType}):`, error);
        res.status(404).json({ message: error.message || "Could not generate report." });
    }
}

/**
 * --- API Endpoint: Generate ZIP of All P&L Reports ---
 */
export async function generateAllPnlReportsZip(req, res, collections) {
    // ... (This function is unchanged)
    const { usersCollection } = collections;
    const archive = archiver('zip', { zlib: { level: 9 } });
    const zipFileName = `Fynax_All_P&L_Reports_${new Date().toISOString().split('T')[0]}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);
    archive.pipe(res);
    try {
        const users = await usersCollection.find({ role: 'user', isBlocked: false }).toArray();
        for (const user of users) {
            try {
                const pdfBuffer = await reportService.getPnLReportAsBuffer(collections, user.userId);
                const storeName = (user.storeName || user.userId.split('@')[0]).replace(/[^a-zA-Z0-9]/g, '_');
                archive.append(pdfBuffer, { name: `P&L_${storeName}.pdf` });
            } catch (err) {
                console.error(`Failed to generate P&L for ${user.userId}: ${err.message}`);
                archive.append(`Failed to generate report: ${err.message}`, { name: `FAILED_P&L_${user.userId.split('@')[0]}.txt` });
            }
        }
        await archive.finalize();
    } catch (error) {
        console.error("Error in generateAllPnlReportsZip:", error);
        res.status(500).json({ message: "An internal server error occurred while creating the ZIP file." });
    }
}

/**
 * --- NEW API Endpoint: Block a User ---
 */
export async function blockUserApi(req, res, collections) {
    const { usersCollection } = collections;
    const { userId } = req.body; // We'll send the userId in the request body

    if (!userId) {
        return res.status(400).json({ message: "userId is required." });
    }

    try {
        const targetUser = await usersCollection.findOne({ userId: userId });
        if (!targetUser) {
            return res.status(404).json({ message: "User not found." });
        }
        if (targetUser.role === 'admin') {
            return res.status(403).json({ message: "Cannot block an admin." });
        }

        await usersCollection.updateOne({ userId: userId }, { $set: { isBlocked: true } });
        res.status(200).json({ success: true, message: `User ${userId} has been blocked.` });
    } catch (error) {
        console.error("Error in blockUserApi:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}

/**
 * --- NEW API Endpoint: Unblock a User ---
 */
export async function unblockUserApi(req, res, collections) {
    const { usersCollection } = collections;
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: "userId is required." });
    }

    try {
        const targetUser = await usersCollection.findOne({ userId: userId });
        if (!targetUser) {
            return res.status(404).json({ message: "User not found." });
        }

        await usersCollection.updateOne({ userId: userId }, { $set: { isBlocked: false } });
        res.status(200).json({ success: true, message: `User ${userId} has been unblocked.` });
    } catch (error) {
        console.error("Error in unblockUserApi:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}


// ==================================================================
// --- BOT COMMAND LOGIC (Unchanged) ---
// ==================================================================
// (This logic for /block, /unblock, /setpass, /help is unchanged)
// ... (rest of the file: blockUser, unblockUser, setPassword, etc.)
// ... (I've removed it for brevity, but you should have the full file)

/**
 * --- Admin Function: Block a User ---
 */
async function blockUser(args, collections, sock, adminUser) {
    const { usersCollection } = collections;
    const phoneToBlock = args[0];
    if (!phoneToBlock) { return await sock.sendMessage(adminUser.userId, { text: "Usage: /block [phone_number]" }); }
    const targetJid = normalizePhone(phoneToBlock);
    if (!targetJid) { return await sock.sendMessage(adminUser.userId, { text: `Invalid phone number format.` }); }
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` }); }
    if (targetUser.role === 'admin') { return await sock.sendMessage(adminUser.userId, { text: `Cannot block another admin.` }); }
    await usersCollection.updateOne({ userId: targetJid }, { $set: { isBlocked: true } });
    await sock.sendMessage(adminUser.userId, { text: `User ${targetUser.userId} has been blocked.` });
}

/**
 * --- Admin Function: Unblock a User ---
 */
async function unblockUser(args, collections, sock, adminUser) {
    const { usersCollection } = collections;
    const phoneToUnblock = args[0];
    if (!phoneToUnblock) { return await sock.sendMessage(adminUser.userId, { text: "Usage: /unblock [phone_number]" }); }
    const targetJid = normalizePhone(phoneToUnblock);
    if (!targetJid) { return await sock.sendMessage(adminUser.userId, { text: `Invalid phone number format.` }); }
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` }); }
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
    if (!phoneToSet || !newPassword) { return await sock.sendMessage(adminUser.userId, { text: "Usage: /setpass [phone_number] [new_password]" }); }
    if (newPassword.length < 6) { return await sock.sendMessage(adminUser.userId, { text: "Password must be at least 6 characters." }); }
    const targetJid = normalizePhone(phoneToSet);
    if (!targetJid) { return await sock.sendMessage(adminUser.userId, { text: `Invalid phone number format.` }); }
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` }); }
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await usersCollection.updateOne({ userId: targetJid }, { $set: { websitePassword: hashedPassword } });
    await sock.sendMessage(adminUser.userId, { text: `Password for ${targetUser.userId} has been changed.` });
    await sock.sendMessage(targetJid, { text: `An admin has reset your web password. Your new password is: \`${newPassword}\`` });
}

/**
 * --- Admin Function: Reply to a User in Live Chat ---
 */
async function replyToUser(args, collections, sock, adminUser) {
    const { usersCollection } = collections;
    const phoneToReply = args[0];
    const message = args.slice(1).join(' ');
    if (!phoneToReply || !message) { return await sock.sendMessage(adminUser.userId, { text: "Usage: /reply [phone_number] [message]" }); }
    const targetJid = normalizePhone(phoneToReply);
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sock.sendMessage(adminUser.userId, { text: `User ${targetJid} not found.` }); }
    await sock.sendMessage(targetJid, { text: `💬 *Support Agent:* ${message}` });
    await sock.sendMessage(adminUser.userId, { text: `✅ Your reply has been sent to ${targetUser.storeName || targetJid}.` });
}

/**
 * --- Admin Function: End a Live Chat Session ---
 */
async function endChat(args, collections, sock, adminUser) {
    const { conversationsCollection } = collections;
    const phoneToEnd = args[0];
    if (!phoneToEnd) { return await sock.sendMessage(adminUser.userId, { text: "Usage: /endchat [phone_number]" }); }
    const targetJid = normalizePhone(phoneToEnd);
    await conversationsCollection.updateOne(
        { userId: targetJid },
        { $set: { chatState: 'bot' }, $unset: { liveChatTicketId: "" } }
    );
    await sock.sendMessage(adminUser.userId, { text: `✅ Chat session ended for ${targetJid}. The bot is now active for them.` });
    await sock.sendMessage(targetJid, { text: `Your chat with the support agent has ended. Fynax Bookkeeper is now active again.` });
}

/**
 * --- Admin Function: List available commands ---
 */
async function showHelp(sock, adminUser) {
    const helpText = `*Fynax Admin Panel* 🔑\n\nAvailable commands:\n
*/reply [phone] [message]*
_Reply to a user in live chat._

*/endchat [phone]*
_End a live chat session and reactivate the bot for a user._

*/block [phone]*
_Stops a user from using the bot._

*/unblock [phone]*
_Re-enables a user._

*/setpass [phone] [new_pass]*
_Resets a user's web password._

*/help*
_Shows this message._`;
    await sock.sendMessage(adminUser.userId, { text: helpText });
}

/**
 * --- Main Admin Command Router (Bot) ---
 */
export async function handleAdminCommand(sock, messageText, collections, adminUser) {
    const parts = messageText.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    switch (command) {
        case '/reply': await replyToUser(args, collections, sock, adminUser); break;
        case '/endchat': await endChat(args, collections, sock, adminUser); break;
        case '/block': await blockUser(args, collections, sock, adminUser); break;
        case '/unblock': await unblockUser(args, collections, sock, adminUser); break;
        case '/setpass': await setPassword(args, collections, sock, adminUser); break;
        case '/help': await showHelp(sock, adminUser); break;
        default: await sock.sendMessage(adminUser.userId, { text: `Unknown command: ${command}\nType /help for a list of commands.` });
    }
}
