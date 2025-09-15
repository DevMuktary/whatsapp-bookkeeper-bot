import { ReportGenerators } from './reportGenerator.js';
import { ObjectId } from 'mongodb';
import OpenAI from 'openai';

const deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
});

const tools = [
  { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory. This is the primary tool for recording sales.', parameters: { type: 'object', properties: { productName: { type: 'string', description: 'The name of the product sold, e.g., "iPhone 17 Air".' }, quantitySold: { type: 'number', description: 'The number of units sold.' }, totalAmount: { type: 'number', description: 'The total income received from the sale.' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } },
  { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense that is NOT a product sale, such as "rent", "utilities", or "service income".', parameters: { type: 'object', properties: { type: { type: 'string', description: 'The type of transaction, either "income" or "expense".' }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string', description: 'For expenses, a category like "rent", "utilities", "transport". Defaults to "Uncategorized".' } }, required: ['type', 'amount', 'description'] } } },
  { type: "function", function: { name: 'addProduct', description: 'Adds one or more new products to inventory. If a product already exists, this updates its price and adds to its stock.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'setOpeningBalance', description: 'Sets the initial inventory or opening balance for a user.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of total income, expenses, and net balance for the current month.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions. Use only when the user explicitly asks to "export", "download", or receive a "PDF report".', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit. Use only when the user explicitly asks for an "inventory report" or "profit report".', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement. Use only when the user asks for a "P&L" or "statement".', parameters: { type: 'object', properties: {} } } },
];

async function logSale(args, collections, senderId) {
    const { transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
    const { productName, quantitySold, totalAmount } = args;

    try {
        const product = await productsCollection.findOne({ 
            userId: senderId, 
            productName: { $regex: new RegExp(`^${productName}$`, "i") } 
        });

        if (!product) {
            return { success: false, message: `Could not find a product named "${productName}" in your inventory.` };
        }

        // 1. Log Income Transaction
        await transactionsCollection.insertOne({
            userId: senderId,
            type: 'income',
            amount: totalAmount,
            description: `Sale of ${quantitySold} x ${product.productName}`,
            category: 'Sales',
            createdAt: new Date()
        });

        // 2. Calculate and Log Cost of Goods Sold (COGS) Expense
        const costOfSale = product.cost * quantitySold;
        if (costOfSale > 0) {
            await transactionsCollection.insertOne({
                userId: senderId,
                type: 'expense',
                amount: costOfSale,
                description: `Cost of Sales for ${quantitySold} x ${product.productName}`,
                category: 'Cost of Goods Sold',
                createdAt: new Date()
            });
        }

        // 3. Update Inventory Stock
        await productsCollection.updateOne({ _id: product._id }, { $inc: { stock: -quantitySold } });

        // 4. Create Inventory Log
        await inventoryLogsCollection.insertOne({
            userId: senderId,
            productId: product._id,
            type: 'sale',
            quantityChange: -quantitySold,
            notes: `Sold ${quantitySold} units`,
            createdAt: new Date()
        });

        console.log(`Sale processed for ${quantitySold} x ${product.productName}. Stock updated.`);
        return { success: true, message: `Sale of ${quantitySold} x ${product.productName} recorded successfully.` };

    } catch (error) {
        console.error('Error in logSale function:', error);
        return { success: false, message: 'An error occurred while processing the sale.' };
    }
}

async function logTransaction(args, collections, senderId) {
    const { transactionsCollection } = collections;
    const { type, amount, description, category = 'Uncategorized' } = args;
    
    try {
        await transactionsCollection.insertOne({ 
            userId: senderId, 
            type, 
            amount, 
            description, 
            category, 
            createdAt: new Date() 
        });
        return { success: true, message: `Logged ${type} of ${amount} for ${description}` };
    } catch (error) {
        console.error('Error logging transaction:', error);
        return { success: false, message: 'Failed to log transaction' };
    }
}

async function addProduct(args, collections, senderId) {
    const { productsCollection, inventoryLogsCollection } = collections;
    const { products } = args;
    let addedProducts = [];
    
    try {
        for (const product of products) {
            const { productName, cost, price, stock } = product;

            const result = await productsCollection.updateOne(
                { userId: senderId, productName: { $regex: new RegExp(`^${productName}$`, "i") } },
                { 
                    $set: { cost, price }, 
                    $inc: { stock: stock }, 
                    $setOnInsert: { userId: senderId, productName, createdAt: new Date() } 
                },
                { upsert: true }
            );

            if (result.upsertedId) {
                 await inventoryLogsCollection.insertOne({ 
                    userId: senderId, 
                    productId: result.upsertedId, 
                    type: 'initial_stock', 
                    quantityChange: stock, 
                    notes: 'Product created', 
                    createdAt: new Date() 
                });
            } else {
                 const existingProduct = await productsCollection.findOne({ userId: senderId, productName: { $regex: new RegExp(`^${productName}$`, "i") } });
                 await inventoryLogsCollection.insertOne({ 
                    userId: senderId, 
                    productId: existingProduct._id, 
                    type: 'purchase', 
                    quantityChange: stock, 
                    notes: 'Added new stock', 
                    createdAt: new Date() 
                });
            }
            
            addedProducts.push(productName);
        }
        return { success: true, count: addedProducts.length, names: addedProducts.join(', ') };
    } catch (error) {
        console.error('Error adding product:', error);
        return { success: false, message: 'Failed to add product(s)' };
    }
}

async function setOpeningBalance(args, collections, senderId) {
    try {
        const result = await addProduct(args, collections, senderId);
        return { ...result, message: "Opening balance set." };
    } catch (error) {
        console.error('Error setting opening balance:', error);
        return { success: false, message: 'Failed to set opening balance' };
    }
}

async function getInventory(args, collections, senderId) {
    const { productsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const products = await productsCollection.find({ userId: senderId }).sort({ productName: 1 }).toArray();
        
        if (products.length === 0) {
            return { success: false, message: "No products found in inventory." };
        }
        
        return { 
            success: true, 
            currency: user?.currency || 'NGN', 
            products: products.map(p => ({ 
                name: p.productName, 
                price: p.price, 
                stock: p.stock 
            })) 
        };
    } catch (error) {
        console.error('Error getting inventory:', error);
        return { success: false, message: 'Failed to retrieve inventory' };
    }
}

async function getMonthlySummary(args, collections, senderId) {
    const { transactionsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const currency = user?.currency || 'NGN';
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
        
        return { 
            success: true, 
            currency, 
            month: startOfMonth.toLocaleString('default', { month: 'long' }), 
            income: totalIncome, 
            expense: totalExpense, 
            net: totalIncome - totalExpense 
        };
    } catch (error) {
        console.error('Error getting monthly summary:', error);
        return { success: false, message: 'Failed to get monthly summary' };
    }
}

async function generateTransactionReport(args, collections, senderId, sock) {
    const { transactionsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const transactions = await transactionsCollection.find({ 
            userId: senderId, 
            createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
        }).sort({ createdAt: 1 }).toArray();
        
        if (transactions.length === 0) {
            return { success: false, message: "No transactions found for this month." };
        }
        
        const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
        const pdfBuffer = await ReportGenerators.createMonthlyReportPDF(transactions, monthName, user);
        
        await sock.sendMessage(senderId, { 
            document: pdfBuffer, 
            mimetype: 'application/pdf', 
            fileName: `Financial_Report_${monthName.replace(/ /g, '_')}.pdf`, 
            caption: `Here is your financial report for ${monthName}.` 
        });
        
        return { success: true, message: "Transaction report has been sent." };
    } catch (error) {
        console.error('Error generating transaction report:', error);
        return { success: false, message: 'Failed to generate transaction report' };
    }
}

async function generateInventoryReport(args, collections, senderId, sock) {
    const { productsCollection, inventoryLogsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const products = await productsCollection.find({ userId: senderId }).toArray();
        const logs = await inventoryLogsCollection.find({ 
            userId: senderId, 
            createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
        }).sort({ createdAt: 1 }).toArray();
        
        if (products.length === 0) {
            return { success: false, message: "No products to report on." };
        }
        
        const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
        const pdfBuffer = await ReportGenerators.createInventoryReportPDF(products, logs, monthName, user);
        
        await sock.sendMessage(senderId, { 
            document: pdfBuffer, 
            mimetype: 'application/pdf', 
            fileName: `Inventory_Report_${monthName.replace(/ /g, '_')}.pdf`, 
            caption: `Here is your inventory and profit report.` 
        });
        
        return { success: true, message: "Inventory report has been sent." };
    } catch (error) {
        console.error('Error generating inventory report:', error);
        return { success: false, message: 'Failed to generate inventory report' };
    }
}

async function generatePnLReport(args, collections, senderId, sock) {
    const { transactionsCollection, inventoryLogsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        
        const income = await transactionsCollection.aggregate([
            { $match: { userId: senderId, type: 'income', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, 
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]).toArray();
        
        const totalRevenue = income[0]?.total || 0;
        
        const expensesResult = await transactionsCollection.find({ 
            userId: senderId, 
            type: 'expense', 
            category: { $ne: 'Cost of Goods Sold' }, // <-- THE FIX IS HERE
            createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
        }).toArray();
        
        if (totalRevenue === 0 && expensesResult.length === 0) {
            return { success: false, message: "No financial activity found for this month." };
        }
        
        const cogsLogs = await inventoryLogsCollection.aggregate([
            { $match: { userId: senderId, type: 'sale', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, 
            { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'productInfo' } }, 
            { $unwind: '$productInfo' }, 
            { $group: { _id: null, total: { $sum: { $multiply: [{ $abs: '$quantityChange' }, '$productInfo.cost'] } } } }
        ]).toArray();
        
        const cogs = cogsLogs[0]?.total || 0;
        
        const expensesByCategory = {};
        expensesResult.forEach(exp => {
            const category = exp.category || 'Uncategorized';
            if (!expensesByCategory[category]) expensesByCategory[category] = 0;
            expensesByCategory[category] += exp.amount;
        });
        
        const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
        const pdfBuffer = await ReportGenerators.createPnLReportPDF({ totalRevenue, cogs, expensesByCategory }, monthName, user);
        
        await sock.sendMessage(senderId, { 
            document: pdfBuffer, 
            mimetype: 'application/pdf', 
            fileName: `P&L_Report_${monthName.replace(/ /g, '_')}.pdf`, 
            caption: `Here is your Profit & Loss Statement.` 
        });
        
        return { success: true, message: "P&L report has been sent." };
    } catch (error) {
        console.error('Error generating P&L report:', error);
        return { success: false, message: 'Failed to generate P&L report' };
    }
}

const availableTools = { 
    logSale,
    logTransaction, 
    addProduct, 
    setOpeningBalance, 
    getInventory, 
    getMonthlySummary, 
    generateTransactionReport, 
    generateInventoryReport, 
    generatePnLReport 
};

async function processMessageWithAI(text, collections, senderId, sock) {
    const { conversationsCollection } = collections;
    
    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        const savedHistory = conversation ? conversation.history : [];
        
        const systemInstruction = `You are 'Smart Accountant', a professional, confident, and friendly AI bookkeeping assistant. Follow these rules with absolute priority: 1. **Use Tools for All Data Questions:** If a user asks a question about their specific financial or inventory data, you MUST use a tool to get the answer. Your primary job is to call the correct function. 2. **Never Explain Yourself:** Do not mention your functions, code, or that you are an AI. Speak as if you are the one performing the action. 3. **CRITICAL RULE:** Never, under any circumstances, write tool call syntax like "<|tool_calls_begin|>" or other code in your text responses. Your responses must be clean, natural language only. 4. **Stay Within Abilities:** ONLY perform actions defined in the available tools. If asked to do something else (like send an email), politely state your purpose is bookkeeping. 5. **Use the Right Tool:** Use 'logSale' for product sales. Use 'logTransaction' for other income/expenses. Use 'getMonthlySummary' for simple questions about totals. Use the 'generate...Report' tools for export requests. 6. **Be Confident & Concise:** When a tool is called, assume it was successful. Announce the result confidently.`;
        
        const messages = [
            { role: "system", content: systemInstruction },
            ...savedHistory,
            { role: "user", content: text }
        ];

        let newHistoryEntries = [{ role: 'user', content: text }];

        const response = await deepseek.chat.completions.create({ 
            model: "deepseek-chat", 
            messages: messages, 
            tools: tools, 
            tool_choice: "auto" 
        });
        
        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
            messages.push(responseMessage);
            
            const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                const selectedTool = availableTools[functionName];
                if (selectedTool) {
                    const functionResult = await selectedTool(functionArgs, collections, senderId, sock);
                    return { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(functionResult) };
                }
                return null;
            });
            
            const toolResponses = (await Promise.all(toolExecutionPromises)).filter(Boolean);
            
            if (toolResponses.length > 0) {
                messages.push(...toolResponses);
                newHistoryEntries.push(responseMessage, ...toolResponses);

                const secondResponse = await deepseek.chat.completions.create({ model: "deepseek-chat", messages: messages });
                responseMessage = secondResponse.choices[0].message;
            } else {
                responseMessage = { role: 'assistant', content: "I'm not sure how to handle that. Could you please rephrase?" };
                newHistoryEntries = [{ role: 'user', content: text }];
            }
        }

        newHistoryEntries.push(responseMessage);

        if (responseMessage.content) {
            const cleanContent = responseMessage.content.replace(/<\|.*?\|>/g, '').trim();
            if (cleanContent) {
                 await sock.sendMessage(senderId, { text: cleanContent });
            }
        }

        const finalHistoryToSave = [...savedHistory, ...newHistoryEntries];
        const MAX_TURNS_TO_KEEP = 5;
        let userMessageCount = 0;
        let startIndex = -1;

        for (let i = finalHistoryToSave.length - 1; i >= 0; i--) {
            if (finalHistoryToSave[i].role === 'user') {
                userMessageCount++;
                if (userMessageCount === MAX_TURNS_TO_KEEP) {
                    startIndex = i;
                    break;
                }
            }
        }

        const prunedHistory = startIndex !== -1 ? finalHistoryToSave.slice(startIndex) : finalHistoryToSave;
        
        await conversationsCollection.updateOne(
            { userId: senderId }, 
            { $set: { history: prunedHistory, updatedAt: new Date() } }, 
            { upsert: true }
        );
        
    } catch (error) {
        console.error("Detailed error in AI message handler:", error);
        throw error;
    }
}

export async function handleMessage(sock, msg, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = msg.key.remoteJid;
    
    const messageContent = msg.message;
    if (!messageContent) return;

    const messageText = messageContent.conversation || messageContent.extendedTextMessage?.text;
    if (!messageText || messageText.trim() === '') return;

    try {
        let user = await usersCollection.findOne({ userId: senderId });
        let conversation = await conversationsCollection.findOne({ userId: senderId });

        if (!user) {
            await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
            await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_store_name', history: [] } }, { upsert: true });
            await sock.sendMessage(senderId, { text: `👋 Welcome to your new AI Bookkeeping Assistant!\n\nTo get started, please tell me the name of your business or store.` });
            return;
        }
        
        if (conversation?.state) {
            switch (conversation.state) {
                case 'awaiting_store_name':
                    await usersCollection.updateOne({ userId: senderId }, { $set: { storeName: messageText } });
                    await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_currency' } });
                    await sock.sendMessage(senderId, { text: `Great! Your store name is set to *${messageText}*.\n\nNow, please select your primary currency (e.g., NGN, USD, GHS, KES).` });
                    return;
                case 'awaiting_currency':
                    const currency = messageText.toUpperCase();
                    await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currency } });
                    await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_opening_balance' } });
                    await sock.sendMessage(senderId, { text: `Perfect. Currency set to *${currency}*.\n\nTo set up your initial stock, you can now tell me about your products. For example:\n\n"My opening balance is 20 phone chargers that cost me 3000 and I sell for 5000"` });
                    return;
                case 'awaiting_opening_balance':
                    await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } });
                    break;
            }
        }
        
        await sock.sendPresenceUpdate('composing', senderId);
        await processMessageWithAI(messageText, collections, senderId, sock);
        
    } catch (error) {
        console.error("Error in message handler:", error);
        await sock.sendMessage(senderId, { text: "Sorry, I encountered an error and couldn't process your request. Please try again." });
    } finally {
        await sock.sendPresenceUpdate('paused', senderId);
    }
}
