import { generateMonthlyReportPDF } from './reportGenerator.js';

async function updateStockAfterSale(description, productsCollection, senderId) {
    // Looks for patterns like "sale of 2x product name" or "sold 2 product name"
    const saleRegex = /(?:sale of|sold)\s*(\d+)x?\s*(.+)/i;
    const match = description.match(saleRegex);

    if (match) {
        const quantitySold = parseInt(match[1], 10);
        const productName = match[2].trim();

        const productQuery = {
            userId: senderId,
            // Case-insensitive search for the product name
            productName: new RegExp(`^${productName}$`, 'i')
        };

        const updateResult = await productsCollection.updateOne(
            productQuery,
            { $inc: { stock: -quantitySold } }
        );

        return updateResult.modifiedCount > 0 ? productName : null;
    }
    return null;
}

export async function handleMessage(sock, msg, collections) {
    const { usersCollection, transactionsCollection, productsCollection } = collections;
    let messageText = '';
    const senderId = msg.key.remoteJid;

    if (msg.message?.conversation) {
        messageText = msg.message.conversation.trim();
    } else { return; }
    
    let user = await usersCollection.findOne({ userId: senderId });
    if (!user) {
        // ... (onboarding logic remains the same)
        await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
        const welcomeMessage = `👋 Welcome to your AI Bookkeeping Assistant!\n\nI'm here to help you track your finances effortlessly.\n\n*To log income:* \`+ 15000 Payment\`\n*To log an expense:* \`- 500 Fuel\`\n\n*To manage products:*\n\`/addproduct <Name> <Price> <Stock>\`\n\`/inventory\`\n\n*To get reports:*\n\`/summary\`\n\`/export\``;
        await sock.sendMessage(senderId, { text: welcomeMessage });
        return;
    }
    
    // --- COMMAND HANDLING ---
    const commandParts = messageText.split(' ');
    const command = commandParts[0].toLowerCase();

    // --- INVENTORY COMMANDS ---
    if (command === '/addproduct') {
        const [_, productName, priceStr, stockStr] = commandParts;
        const price = parseFloat(priceStr);
        const stock = parseInt(stockStr, 10);

        if (!productName || isNaN(price) || isNaN(stock)) {
            await sock.sendMessage(senderId, { text: "❌ Invalid format. Use: \n`/addproduct <Name> <Price> <Stock>`\nExample: `/addproduct Soap 500 20`" });
            return;
        }

        const existingProduct = await productsCollection.findOne({ userId: senderId, productName: new RegExp(`^${productName}$`, 'i') });
        if (existingProduct) {
            await sock.sendMessage(senderId, { text: `❌ Product "${productName}" already exists.` });
            return;
        }

        await productsCollection.insertOne({ userId: senderId, productName, price, stock, createdAt: new Date() });
        await sock.sendMessage(senderId, { text: `✅ Product "${productName}" added to your inventory.` });
        return;
    }

    if (command === '/inventory') {
        const products = await productsCollection.find({ userId: senderId }).toArray();
        if (products.length === 0) {
            await sock.sendMessage(senderId, { text: "You have no products in your inventory. Add one with `/addproduct`." });
            return;
        }
        let inventoryList = "📦 *Your Inventory*\n\n*Name | Price | Stock*\n---------------------\n";
        products.forEach(p => {
            inventoryList += `${p.productName} | ₦${p.price.toLocaleString()} | ${p.stock}\n`;
        });
        await sock.sendMessage(senderId, { text: inventoryList });
        return;
    }
    
    if (command === '/removeproduct') {
        const productName = commandParts.slice(1).join(' ');
        if (!productName) {
            await sock.sendMessage(senderId, { text: "❌ Please specify a product name to remove.\nExample: `/removeproduct Soap`"});
            return;
        }
        const result = await productsCollection.deleteOne({ userId: senderId, productName: new RegExp(`^${productName}$`, 'i') });
        if (result.deletedCount > 0) {
            await sock.sendMessage(senderId, { text: `✅ Product "${productName}" has been removed.`});
        } else {
            await sock.sendMessage(senderId, { text: `❌ Product "${productName}" not found.`});
        }
        return;
    }

    // --- REPORTING COMMANDS ---
    if (command === '/summary' || command === '/export') {
        // ... (logic remains the same)
    }

    // --- TRANSACTION LOGIC (+/-) ---
    if (messageText.trim().startsWith('+') || messageText.trim().startsWith('-')) {
        const type = messageText.trim().startsWith('+') ? 'income' : 'expense';
        const parts = messageText.substring(1).trim().split(' ');
        const amount = parseFloat(parts[0].replace(/,/g, ''));
        if (isNaN(amount)) {
            await sock.sendMessage(senderId, { text: "❌ Invalid amount." }); return;
        }
        const description = parts.slice(1).join(' ');
        if (!description) {
            await sock.sendMessage(senderId, { text: "❌ Please provide a description." }); return;
        }

        // SMART STOCK UPDATE
        let replyMessage = '✅ Transaction logged successfully!';
        if (type === 'income') {
            const productSold = await updateStockAfterSale(description, productsCollection, senderId);
            if (productSold) {
                replyMessage += `\n_Stock for "${productSold}" has been updated._`;
            }
        }
        
        await transactionsCollection.insertOne({ userId: senderId, type, amount, description, createdAt: new Date() });
        await sock.sendMessage(senderId, { text: replyMessage });
        return;
    }
}
