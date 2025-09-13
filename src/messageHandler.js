import { downloadMediaMessage } from '@whiskeysockets/baileys';

// We've removed the audio processing for now as requested.
// We will add it back here later, along with image processing.

export async function handleMessage(sock, msg, collections) {
    const { usersCollection, transactionsCollection } = collections;
    let messageText = '';
    const senderId = msg.key.remoteJid;

    if (msg.message?.conversation) {
        messageText = msg.message.conversation.trim();
    } else {
        // For now, we ignore non-text messages
        return;
    }

    let user = await usersCollection.findOne({ userId: senderId });
    if (!user) {
        await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
        const welcomeMessage = `👋 Welcome to your AI Bookkeeping Assistant!\n\nI'm here to help you track your finances effortlessly.\n\n*To log income:* \nStart your message with a plus sign (+).\nExample: \`+ 15000 Payment from client\`\n\n*To log an expense:* \nStart your message with a minus sign (-).\nExample: \`- 500 Fuel for generator\`\n\nTo see your monthly summary, just send: \`/summary\``;
        await sock.sendMessage(senderId, { text: welcomeMessage });
        return;
    }

    if (messageText.toLowerCase() === '/summary') {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const summary = await transactionsCollection.aggregate([
            { $match: { userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } } },
            { $group: { _id: "$type", totalAmount: { $sum: "$amount" } } }
        ]).toArray();
        let totalIncome = 0, totalExpense = 0;
        summary.forEach(item => {
            if (item._id === 'income') totalIncome = item.totalAmount;
            if (item._id === 'expense') totalExpense = item.totalAmount;
        });
        const net = totalIncome - totalExpense;
        const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
        const summaryMessage = `📊 *Financial Summary for ${monthName}*\n\n*Total Income:* ₦${totalIncome.toLocaleString()}\n*Total Expense:* ₦${totalExpense.toLocaleString()}\n---------------------\n*Net Balance:* *₦${net.toLocaleString()}*`;
        await sock.sendMessage(senderId, { text: summaryMessage });
        return;
    }

    let type = '';
    if (messageText.trim().startsWith('+')) type = 'income';
    if (messageText.trim().startsWith('-')) type = 'expense';

    if (type !== '') {
        const parts = messageText.substring(1).trim().split(' ');
        const amount = parseFloat(parts[0].replace(/,/g, ''));
        if (isNaN(amount)) {
            await sock.sendMessage(senderId, { text: "❌ Invalid amount. Please use a number. \nExample: `+ 5000 rent`" });
            return;
        }
        const description = parts.slice(1).join(' ');
        if (!description) {
            await sock.sendMessage(senderId, { text: "❌ Please provide a description. \nExample: `+ 5000 rent`" });
            return;
        }
        try {
            await transactionsCollection.insertOne({ userId: senderId, type, amount, description, createdAt: new Date() });
            await sock.sendMessage(senderId, { text: '✅ Transaction logged successfully!' });
        } catch (error) {
            console.error("Failed to log transaction:", error);
            await sock.sendMessage(senderId, { text: 'Sorry, there was an error saving your transaction.' });
        }
        return;
    }
}
