import { generateMonthlyReportPDF, generateInventoryReportPDF } from './reportGenerator.js';
import { ObjectId } from 'mongodb';

// --- Helper function for Smarter Stock Updates ---
async function updateStockAfterSale(description, collections, senderId) {
    const { productsCollection, inventoryLogsCollection } = collections;
    // Looks for patterns like "sale of 2x product name" or "sold 2 product name"
    const saleRegex = /(?:sale of|sold)\s*(\d+)x?\s*(.+)/i;
    const match = description.match(saleRegex);

    if (match) {
        const quantitySold = parseInt(match[1], 10);
        const productNameQuery = match[2].trim();

        // Split search query into words and create a case-insensitive regex for each
        const searchWords = productNameQuery.split(' ').map(word => new RegExp(word, 'i'));

        // Find a product where the name contains all search words
        const product = await productsCollection.findOne({ 
            userId: senderId, 
            productName: { $all: searchWords } 
        });

        if (!product) return null; // Product not found

        // Update stock and log the inventory movement
        await productsCollection.updateOne({ _id: product._id }, { $inc: { stock: -quantitySold } });
        await inventoryLogsCollection.insertOne({
            userId: senderId,
            productId: product._id,
            type: 'sale',
            quantityChange: -quantitySold,
            notes: description,
            createdAt: new Date()
        });

        return product.productName;
    }
    return null;
}

export async function handleMessage(sock, msg, collections) {
    const { usersCollection, transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
    let messageText = '';
    const senderId = msg.key.remoteJid;

    if (msg.message?.conversation) {
        messageText = msg.message.conversation.trim();
    } else { 
        // We currently only process text messages, so ignore others
        return; 
    }
    
    // Check if user exists, if not, onboard them
    let user = await usersCollection.findOne({ userId: senderId });
    if (!user) {
        await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
        const welcomeMessage = `👋 Welcome to your AI Bookkeeping Assistant!\n\nI'm here to help you track your finances and inventory effortlessly.\n\n*TRANSACTIONS:*\n*Log income:* \`+ 15000 Payment\`\n*Log an expense:* \`- 500 Fuel\`\n*Smart Sale:* \`+ 10000 sale of 2x Soap\`\n\n*INVENTORY:*\n*Add Products:* \`/addproduct <Name> <Cost> <Price> <Stock>\` (you can add multiple lines)\n*Check Stock:* \`/inventory\`\n*Remove Product:* \`/removeproduct <Name>\`\n\n*REPORTS:*\n*Quick Summary:* \`/summary\`\n*PDF Transaction Report:* \`/export\`\n*PDF Inventory & Profit Report:* \`/exportinventory\``;
        await sock.sendMessage(senderId, { text: welcomeMessage });
        return;
    }
    
    const commandParts = messageText.split(' ');
    const command = commandParts[0].toLowerCase();
    
    // --- INVENTORY COMMANDS ---
    if (command === '/addproduct') {
        const content = messageText.substring(command.length).trim();
        const lines = content.split('\n').filter(line => line.trim() !== '');

        if (lines.length === 0) {
            await sock.sendMessage(senderId, { text: "❌ Invalid format. Use: \n`/addproduct <Name> <Cost> <Price> <Stock>`" });
            return;
        }

        let addedProducts = [];
        let errors = [];

        for (const line of lines) {
            const parts = line.trim().split(' ');
            if (parts.length < 4) {
                errors.push(`- Invalid format for line: "${line}"`);
                continue;
            }
            const stock = parseInt(parts.pop(), 10);
            const price = parseFloat(parts.pop());
            const cost = parseFloat(parts.pop());
            const productName = parts.join(' ');

            if (isNaN(cost) || isNaN(price) || isNaN(stock)) {
                errors.push(`- Invalid numbers for line: "${line}"`);
                continue;
            }

            const newProduct = await productsCollection.insertOne({ userId: senderId, productName, cost, price, stock, createdAt: new Date() });
            await inventoryLogsCollection.insertOne({
                userId: senderId,
                productId: newProduct.insertedId,
                type: 'initial_stock',
                quantityChange: stock,
                notes: 'Product Added',
                createdAt: new Date()
            });
            addedProducts.push(productName);
        }

        let reply = '';
        if (addedProducts.length > 0) {
            reply += `✅ Successfully added ${addedProducts.length} product(s): ${addedProducts.join(', ')}\n`;
        }
        if (errors.length > 0) {
            reply += `❌ Encountered errors:\n${errors.join('\n')}`;
        }
        await sock.sendMessage(senderId, { text: reply });
        return;
    }

    if (command === '/inventory') {
        const products = await productsCollection.find({ userId: senderId }).sort({ productName: 1 }).toArray();
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
        // Case-insensitive find
        const productToRemove = await productsCollection.findOne({ userId: senderId, productName: new RegExp(`^${productName}$`, 'i') });

        if (productToRemove) {
            await productsCollection.deleteOne({ _id: productToRemove._id });
            await inventoryLogsCollection.insertOne({
                userId: senderId,
                productId: productToRemove._id,
                type: 'removed',
                quantityChange: 0,
                notes: 'Product removed from inventory',
                createdAt: new Date()
            });
            await sock.sendMessage(senderId, { text: `✅ Product "${productToRemove.productName}" has been removed.`});
        } else {
            await sock.sendMessage(senderId, { text: `❌ Product "${productName}" not found.`});
        }
        return;
    }

    // --- REPORTING COMMANDS ---
    if (command === '/summary') {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const summary = await transactionsCollection.aggregate([
            { $match: { userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } } },
            { $group: { _id: "$type", totalAmount: { $sum: "$amount" } } }
        ]).toArray();
        let totalIncome = 0;
        let totalExpense = 0;
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

    if (command === '/export') {
        await sock.sendMessage(senderId, { text: 'Generating your monthly transaction report... 📄' });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        
        const transactions = await transactionsCollection.find({ 
            userId: senderId, 
            createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
        }).sort({ createdAt: 1 }).toArray();

        if (transactions.length === 0) {
            await sock.sendMessage(senderId, { text: "You have no transactions this month to export." });
            return;
        }

        const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
        const pdfBuffer = await generateMonthlyReportPDF(transactions, monthName);

        const messageOptions = {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: `Financial_Report_${monthName.replace(' ', '_')}.pdf`,
            caption: `Here is your financial report for ${monthName}.`
        };
        await sock.sendMessage(senderId, messageOptions);
        return;
    }

    if (command === '/exportinventory') {
        await sock.sendMessage(senderId, { text: 'Generating your inventory & profit report... 📦' });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

        const products = await productsCollection.find({ userId: senderId }).toArray();
        const logs = await inventoryLogsCollection.find({
            userId: senderId,
            createdAt: { $gte: startOfMonth, $lte: endOfMonth }
        }).sort({ createdAt: 1 }).toArray();

        if (products.length === 0) {
            await sock.sendMessage(senderId, { text: "You have no products to report on." });
            return;
        }

        const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
        const pdfBuffer = await generateInventoryReportPDF(products, logs, monthName);

        const messageOptions = {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: `Inventory_Report_${monthName.replace(' ', '_')}.pdf`,
            caption: `Here is your inventory and profit report for ${monthName}.`
        };
        await sock.sendMessage(senderId, messageOptions);
        return;
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

        let replyMessage = '✅ Transaction logged successfully!';
        if (type === 'income') {
            const productSold = await updateStockAfterSale(description, { productsCollection, inventoryLogsCollection }, senderId);
            if (productSold) {
                replyMessage += `\n_Stock for "${productSold}" has been updated._`;
            }
        }
        
        await transactionsCollection.insertOne({ userId: senderId, type, amount, description, createdAt: new Date() });
        await sock.sendMessage(senderId, { text: replyMessage });
        return;
    }
}
