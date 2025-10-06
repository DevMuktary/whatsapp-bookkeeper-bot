import bcrypt from 'bcrypt';
import { normalizePhone } from '../utils/helpers.js';
import * as reportService from './reportService.js';
import archiver from 'archiver';
import { sendMessage } from './whatsappService.js'; // <-- NEW IMPORT

const SALT_ROUNDS = 10;

// ==================================================================
// --- API ENDPOINT LOGIC (Unchanged) ---
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
 * --- API Endpoint: Block a User ---
 */
export async function blockUserApi(req, res, collections) {
    const { usersCollection } = collections;
    const { userId } = req.body;
    if (!userId) { return res.status(400).json({ message: "userId is required." }); }
    try {
        const targetUser = await usersCollection.findOne({ userId: userId });
        if (!targetUser) { return res.status(404).json({ message: "User not found." }); }
        if (targetUser.role === 'admin') { return res.status(403).json({ message: "Cannot block an admin." }); }
        await usersCollection.updateOne({ userId: userId }, { $set: { isBlocked: true } });
        res.status(200).json({ success: true, message: `User ${userId} has been blocked.` });
    } catch (error) {
        console.error("Error in blockUserApi:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}

/**
 * --- API Endpoint: Unblock a User ---
 */
export async function unblockUserApi(req, res, collections) {
    const { usersCollection } = collections;
    const { userId } = req.body;
    if (!userId) { return res.status(400).json({ message: "userId is required." }); }
    try {
        const targetUser = await usersCollection.findOne({ userId: userId });
        if (!targetUser) { return res.status(404).json({ message: "User not found." }); }
        await usersCollection.updateOne({ userId: userId }, { $set: { isBlocked: false } });
        res.status(200).json({ success: true, message: `User ${userId} has been unblocked.` });
    } catch (error) {
        console.error("Error in unblockUserApi:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
}


// ==================================================================
// --- BOT COMMAND LOGIC (MIGRATED) ---
// ==================================================================

async function blockUser(args, collections, adminUser) {
    const { usersCollection } = collections;
    const phoneToBlock = args[0];
    if (!phoneToBlock) { return await sendMessage(adminUser.userId, "Usage: /block [phone_number]"); }
    const targetJid = normalizePhone(phoneToBlock);
    if (!targetJid) { return await sendMessage(adminUser.userId, `Invalid phone number format.`); }
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sendMessage(adminUser.userId, `User ${targetJid} not found.`); }
    if (targetUser.role === 'admin') { return await sendMessage(adminUser.userId, `Cannot block another admin.`); }
    await usersCollection.updateOne({ userId: targetJid }, { $set: { isBlocked: true } });
    await sendMessage(adminUser.userId, `User ${targetUser.userId} has been blocked.`);
}

async function unblockUser(args, collections, adminUser) {
    const { usersCollection } = collections;
    const phoneToUnblock = args[0];
    if (!phoneToUnblock) { return await sendMessage(adminUser.userId, "Usage: /unblock [phone_number]"); }
    const targetJid = normalizePhone(phoneToUnblock);
    if (!targetJid) { return await sendMessage(adminUser.userId, `Invalid phone number format.`); }
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sendMessage(adminUser.userId, `User ${targetJid} not found.`); }
    await usersCollection.updateOne({ userId: targetJid }, { $set: { isBlocked: false } });
    await sendMessage(adminUser.userId, `User ${targetUser.userId} has been unblocked.`);
}

async function setPassword(args, collections, adminUser) {
    const { usersCollection } = collections;
    const phoneToSet = args[0];
    const newPassword = args[1];
    if (!phoneToSet || !newPassword) { return await sendMessage(adminUser.userId, "Usage: /setpass [phone_number] [new_password]"); }
    if (newPassword.length < 6) { return await sendMessage(adminUser.userId, "Password must be at least 6 characters."); }
    const targetJid = normalizePhone(phoneToSet);
    if (!targetJid) { return await sendMessage(adminUser.userId, `Invalid phone number format.`); }
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sendMessage(adminUser.userId, `User ${targetJid} not found.`); }
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await usersCollection.updateOne({ userId: targetJid }, { $set: { websitePassword: hashedPassword } });
    await sendMessage(adminUser.userId, `Password for ${targetUser.userId} has been changed.`);
    await sendMessage(targetJid, `An admin has reset your web password. Your new password is: \`${newPassword}\``);
}

async function replyToUser(args, collections, adminUser) {
    const { usersCollection } = collections;
    const phoneToReply = args[0];
    const message = args.slice(1).join(' ');
    if (!phoneToReply || !message) { return await sendMessage(adminUser.userId, "Usage: /reply [phone_number] [message]"); }
    const targetJid = normalizePhone(phoneToReply);
    const targetUser = await usersCollection.findOne({ userId: targetJid });
    if (!targetUser) { return await sendMessage(adminUser.userId, `User ${targetJid} not found.`); }
    await sendMessage(targetJid, `💬 *Support Agent:* ${message}`);
    await sendMessage(adminUser.userId, `✅ Your reply has been sent to ${targetUser.storeName || targetJid}.`);
}

async function endChat(args, collections, adminUser) {
    const { conversationsCollection } = collections;
    const phoneToEnd = args[0];
    if (!phoneToEnd) { return await sendMessage(adminUser.userId, "Usage: /endchat [phone_number]"); }
    const targetJid = normalizePhone(phoneToEnd);
    await conversationsCollection.updateOne(
        { userId: targetJid },
        { $set: { chatState: 'bot' }, $unset: { liveChatTicketId: "" } }
    );
    await sendMessage(adminUser.userId, `✅ Chat session ended for ${targetJid}. The bot is now active for them.`);
    await sendMessage(targetJid, `Your chat with the support agent has ended. Fynax Bookkeeper is now active again.`);
}

async function showHelp(adminUser) {
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
    await sendMessage(adminUser.userId, helpText);
}

/**
 * --- Main Admin Command Router (Bot) ---
 */
export async function handleAdminCommand(messageText, collections, adminUser) {
    const parts = messageText.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    switch (command) {
        case '/reply': await replyToUser(args, collections, adminUser); break;
        case '/endchat': await endChat(args, collections, adminUser); break;
        case '/block': await blockUser(args, collections, adminUser); break;
        case '/unblock': await unblockUser(args, collections, adminUser); break;
        case '/setpass': await setPassword(args, collections, adminUser); break;
        case '/help': await showHelp(adminUser); break;
        default: await sendMessage(adminUser.userId, `Unknown command: ${command}\nType /help for a list of commands.`);
    }
}
