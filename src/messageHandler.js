import { ReportGenerators } from './reportGenerator.js';
import { ObjectId } from 'mongodb';
import OpenAI from 'openai';

const deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
});

const tools = [
  { type: "function", function: { name: 'logTransaction', description: 'Logs a new income or expense transaction.', parameters: { type: 'object', properties: { type: { type: 'string', description: 'The type of transaction, either "income" or "expense".' }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string', description: 'For expenses, a category like "rent", "utilities", "transport". Defaults to "Uncategorized".' } }, required: ['type', 'amount', 'description'] } } },
  { type: "function", function: { name: 'addProduct', description: 'Adds one or more new products to inventory.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'setOpeningBalance', description: 'Sets the initial inventory or opening balance for a user.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of total income, expenses, and net balance for the current month.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions. Use only when the user explicitly asks to "export", "download", or receive a "PDF report".', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit. Use only when the user explicitly asks for an "inventory report" or "profit report".', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement. Use only when the user asks for a "P&L" or "statement".', parameters: { type: 'object', properties: {} } } },
];

// Helper function to update stock after sale - moved to top to avoid hoisting issues
async function updateStockAfterSale(description, collections, senderId) {
    const { productsCollection, inventoryLogsCollection } = collections;
    const saleRegex = /(?:sale of|sold)\s*(\d+)\s*x?\s*(.+)/i;
    const match = description.match(saleRegex);

    if (match) {
        const quantitySold = parseInt(match[1], 10);
        const productNameQuery = match[2].trim();
        
        try {
            const product = await productsCollection.findOne({ 
                userId: senderId, 
                productName: { $regex: new RegExp(productNameQuery, "i") } 
            });

            if (!product) {
                console.log(`Could not find product matching "${productNameQuery}" to update stock.`);
                return null;
            }

            await productsCollection.updateOne({ _id: product._id }, { $inc: { stock: -quantitySold } });
            await inventoryLogsCollection.insertOne({ 
                userId: senderId, 
                productId: product._id, 
                type: 'sale', 
                quantityChange: -quantitySold, 
                notes: description, 
                createdAt: new Date() 
            });
            
            const newStock = (product.stock || 0) - quantitySold;
            console.log(`Stock updated for ${product.productName}: sold ${quantitySold}, remaining ${newStock}`);
            return product.productName;
        } catch (error) {
            console.error('Error updating stock after sale:', error);
            return null;
        }
    }
    return null;
}

async function logTransaction(args, collections, senderId) {
    const { transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
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
        
        if (type === 'income') {
            await updateStockAfterSale(description, { productsCollection, inventoryLogsCollection }, senderId);
        }
        
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
            const newProduct = await productsCollection.insertOne({ 
                userId: senderId, 
                productName, 
                cost, 
                price, 
                stock, 
                createdAt: new Date() 
            });
            
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
    
    // Check environment variable
    if (!process.env.DEEPSEEK_API_KEY) {
        console.error("DEEPSEEK_API_KEY is not set!");
        throw new Error("API key not configured");
    }
    
    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        const savedHistory = conversation ? conversation.history : [];
        
        const systemInstruction = `You are 'Smart Accountant', a professional, confident, and friendly AI bookkeeping assistant. Follow these rules with absolute priority: 1. **Use Tools for All Data Questions:** If a user asks a question about their specific financial or inventory data (e.g., "what are my expenses?", "how many soaps do I have?"), you MUST use a tool to get the answer. Do not answer from your own knowledge or provide placeholder text like '[Amount]'. Your primary job is to call the correct function. 2. **Never Explain Yourself:** Do not mention your functions, code, or that you are an AI. Never explain your limitations or internal thought process (e.g., do not say "I cannot access data"). Speak as if you are the one performing the action. 3. **Stay Within Abilities:** ONLY perform actions defined in the available tools. If asked to do something else (like send an email or browse the web), politely state your purpose is bookkeeping. 4. **Use the Right Tool:** For simple questions about totals (e.g., "what are my expenses?"), use 'getMonthlySummary'. For requests to "export", "download", "send the file", or receive a "PDF report", use the appropriate 'generate...Report' tool. 5. **Be Confident & Concise:** When a tool is called, assume it was successful. Announce the result confidently and briefly. 6. **Stay On Topic:** If asked about things unrelated to bookkeeping (e.g., science, general knowledge), politely guide the user back to your purpose.`;
        
        const messages = [
            { role: "system", content: systemInstruction },
            ...savedHistory,
            { role: "user", content: text }
        ];

        let newHistoryEntries = [{ role: 'user', content: text }];

        console.log("Making API call to DeepSeek with:", {
            messagesCount: messages.length,
            toolsCount: tools.length
        });

        const response = await deepseek.chat.completions.create({ 
            model: "deepseek-chat", 
            messages: messages, 
            tools: tools, 
            tool_choice: "auto" 
        });
        
        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
            messages.push(responseMessage);
            
            // Fixed tool execution with proper error handling
            const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                let functionArgs;
                
                try {
                    functionArgs = JSON.parse(toolCall.function.arguments);
                } catch (parseError) {
                    console.error(`Failed to parse tool arguments for ${functionName}:`, parseError);
                    return {
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: functionName,
                        content: JSON.stringify({ 
                            success: false, 
                            message: "Invalid function arguments provided" 
                        })
                    };
                }
                
                const selectedTool = availableTools[functionName];
                
                if (selectedTool) {
                    try {
                        const functionResult = await selectedTool(functionArgs, collections, senderId, sock);
                        return {
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: functionName,
                            content: JSON.stringify(functionResult)
                        };
                    } catch (toolError) {
                        console.error(`Tool execution error for ${functionName}:`, toolError);
                        return {
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: functionName,
                            content: JSON.stringify({ 
                                success: false, 
                                message: "Tool execution failed" 
                            })
                        };
                    }
                } else {
                    console.error(`Tool not found: ${functionName}`);
                    return {
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: functionName,
                        content: JSON.stringify({ 
                            success: false, 
                            message: `Tool '${functionName}' is not available` 
                        })
                    };
                }
            });
            
            const toolResponses = await Promise.all(toolExecutionPromises);
            
            if (toolResponses.length > 0) {
                messages.push(...toolResponses);
                newHistoryEntries.push(responseMessage, ...toolResponses);

                const secondResponse = await deepseek.chat.completions.create({ 
                    model: "deepseek-chat", 
                    messages: messages 
                });
                responseMessage = secondResponse.choices[0].message;
            }
        }

        newHistoryEntries.push(responseMessage);

        if (responseMessage.content) {
            await sock.sendMessage(senderId, { text: responseMessage.content });
        }

        const finalHistoryToSave = [...savedHistory, ...newHistoryEntries];
        const prunedHistory = finalHistoryToSave.slice(-10); 
        
        await conversationsCollection.updateOne(
            { userId: senderId }, 
            { $set: { history: prunedHistory, updatedAt: new Date() } }, 
            { upsert: true }
        );
        
    } catch (error) {
        console.error("Detailed error in AI message handler:", {
            message: error.message,
            stack: error.stack,
            senderId,
            messageText: text
        });
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

    console.log("Collections status:", {
        users: !!collections.usersCollection,
        conversations: !!collections.conversationsCollection,
        transactions: !!collections.transactionsCollection,
        products: !!collections.productsCollection,
        inventoryLogs: !!collections.inventoryLogsCollection
    });

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
        console.error("Error in message handler:", {
            message: error.message,
            stack: error.stack,
            senderId,
            messageText
        });
        await sock.sendMessage(senderId, { text: "Sorry, I encountered an error and couldn't process your request. Please try again." });
    } finally {
        await sock.sendPresenceUpdate('paused', senderId);
    }
}
