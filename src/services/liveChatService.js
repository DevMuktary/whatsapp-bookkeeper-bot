/**
 * --- BOT TOOL: Request Live Chat ---
 * Sets the user's state to 'live' and notifies all admins.
 */
export async function requestLiveChat(args, collections, senderId, sock, user) {
    const { conversationsCollection, usersCollection } = collections;
    const { issue = "No issue provided" } = args;

    try {
        // 1. Set user's state to 'live'
        await conversationsCollection.updateOne(
            { userId: senderId },
            { $set: { chatState: 'live', liveChatTicketId: new Date().getTime() } }
        );

        // 2. Get all admins
        const admins = await usersCollection.find({ role: 'admin' }).toArray();
        if (admins.length === 0) {
            console.error("LIVE CHAT: No admins found to notify.");
            return { success: false, message: "Sorry, there are no support agents available right now." };
        }

        // 3. Notify all admins
        const adminMessage = `🔔 LIVE CHAT REQUEST 🔔
        
User: ${user.storeName || senderId}
Issue: ${issue}

To reply, use the command:
/reply ${senderId.split('@')[0]} [your message]`;

        for (const admin of admins) {
            await sock.sendMessage(admin.userId, { text: adminMessage });
        }

        // 4. Confirm to user
        return { success: true, message: "Connecting you to a support agent... Please describe your issue in detail. The bot is now paused." };
    
    } catch (error) {
        console.error("Error in requestLiveChat:", error);
        return { success: false, message: "An error occurred while trying to connect you to support." };
    }
}

/**
 * --- LIVE CHAT ROUTER: Forward User Message ---
 * Forwards a message from a 'live' user to all admins.
 */
export async function forwardLiveMessage(sock, msg, collections, user) {
    const { usersCollection } = collections;
    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!messageText) return; // Not a text message

    try {
        const admins = await usersCollection.find({ role: 'admin' }).toArray();
        const userName = user.storeName || user.userId.split('@')[0];

        const forwardText = `💬 [LIVE CHAT from ${userName}]:

${messageText}`;

        for (const admin of admins) {
            await sock.sendMessage(admin.userId, { text: forwardText });
        }
    } catch (error) {
        console.error("Error in forwardLiveMessage:", error);
    }
}
