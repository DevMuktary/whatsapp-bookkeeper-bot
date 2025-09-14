import { ReportGenerators } from './reportGenerator.js';
import { ObjectId } from 'mongodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [
  {
    name: 'logTransaction',
    description: 'Logs a new income or expense transaction. Also use for sales of products. For expenses, try to identify a category from the description.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'The type of transaction, either "income" or "expense".' },
        amount: { type: 'number', description: 'The numerical amount of the transaction.' },
        description: { type: 'string', description: 'A detailed description of the transaction, including product names and quantities if it is a sale.' },
        category: { type: 'string', description: 'For expenses, a category like "rent", "utilities", "transport", "cost_of_goods", etc. Defaults to "Uncategorized".' }
      },
      required: ['type', 'amount', 'description'],
    },
  },
  {
    name: 'addProduct',
    description: 'Adds one or more new products to the user\'s inventory. Should be used for regular restocking after the initial setup.',
    parameters: {
      type: 'object',
      properties: {
        products: {
          type: 'array',
          description: 'An array of products to add.',
          items: {
            type: 'object',
            properties: {
              productName: { type: 'string', description: 'The name of the product.' },
              cost: { type: 'number', description: 'The cost price of one unit of the product.' },
              price: { type: 'number', description: 'The selling price of one unit of the product.' },
              stock: { type: 'number', description: 'The initial quantity in stock.' },
            },
            required: ['productName', 'cost', 'price', 'stock'],
          },
        },
      },
      required: ['products'],
    },
  },
  {
    name: 'setOpeningBalance',
    description: 'Sets the initial inventory or opening balance for a user. This is typically a one-time setup action when the user first adds all their existing products.',
    parameters: {
      type: 'object',
      properties: {
        products: {
          type: 'array',
          description: 'An array of all the user\'s starting products.',
          items: {
            type: 'object',
            properties: {
              productName: { type: 'string', description: 'The name of the product.' },
              cost: { type: 'number', description: 'The cost price of one unit of the product.' },
              price: { type: 'number', description: 'The selling price of one unit of the product.' },
              stock: { type: 'number', description: 'The initial quantity in stock.' },
            },
            required: ['productName', 'cost', 'price', 'stock'],
          },
        },
      },
      required: ['products'],
    },
  },
  {
    name: 'getInventory',
    description: 'Retrieves and displays a list of all products in the user\'s inventory.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'getMonthlySummary',
    description: 'Gets a quick text summary of total income, expenses, and net balance for the current month. Use for simple questions about totals, like "what are my expenses?" or "how much did I make?"',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'generateTransactionReport',
    description: 'Generates and sends a detailed PDF FILE of all financial transactions for the current month. Use this only when the user explicitly asks to "export", "download", "send the file", or receive a "PDF report" of their transactions.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'generateInventoryReport',
    description: 'Generates and sends a detailed PDF FILE of inventory, sales, and profit for the current month. Use this only when the user explicitly asks to "export", "download", or receive a "report file" related to inventory or profit.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'generatePnLReport',
    description: 'Generates and sends a professional Profit and Loss (P&L) PDF FILE for the current month. Use this only when the user explicitly asks for a "P&L", "statement", or "profit and loss report".',
    parameters: { type: 'object', properties: {} },
  },
];

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest",
  tool_config: { function_calling_config: { mode: "any" } }
});

// --- Specialist Functions now return DATA for the AI to process ---

async function logTransaction(args, collections, senderId) {
    const { transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
    const { type, amount, description, category = 'Uncategorized' } = args;

    await transactionsCollection.insertOne({ userId: senderId, type, amount, description, category, createdAt: new Date() });

    if (type === 'income') {
        await updateStockAfterSale(description, { productsCollection, inventoryLogsCollection }, senderId);
    }
    return { success: true, message: `Logged ${type} of ${amount} for ${description}` };
}

async function addProduct(args, collections, senderId) {
    const { productsCollection, inventoryLogsCollection } = collections;
    const { products } = args;
    let addedProducts = [];

    for (const product of products) {
        const { productName, cost, price, stock } = product;
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
    return { success: true, count: addedProducts.length, names: addedProducts.join(', ') };
}

async function setOpeningBalance(args, collections, senderId) {
    const result = await addProduct(args, collections, senderId);
    return { ...result, message: "Opening balance set." };
}

async function getInventory(args, collections, senderId) {
    const { productsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: senderId });
    const products = await productsCollection.find({ userId: senderId }).sort({ productName: 1 }).toArray();
    if (products.length === 0) {
        return { success: false, message: "No products found in inventory." };
    }
    return {
        success: true,
        currency: user.currency || 'CURRENCY',
        products: products.map(p => ({ name: p.productName, price: p.price, stock: p.stock }))
    };
}

async function getMonthlySummary(args, collections, senderId) {
    const { transactionsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: senderId });
    const currency = user.currency || 'CURRENCY';
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
    
    return {
        success: true,
        currency: currency,
        month: startOfMonth.toLocaleString('default', { month: 'long' }),
        income: totalIncome,
        expense: totalExpense,
        net: totalIncome - totalExpense
    };
}

async function generateTransactionReport(args, collections, senderId, sock) {
    const { transactionsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: senderId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const transactions = await transactionsCollection.find({ userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).sort({ createdAt: 1 }).toArray();

    if (transactions.length === 0) {
        return { success: false, message: "No transactions found for this month." };
    }

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const pdfBuffer = await ReportGenerators.createMonthlyReportPDF(transactions, monthName, user);
    await sock.sendMessage(senderId, { document: pdfBuffer, mimetype: 'application/pdf', fileName: `Financial_Report_${monthName.replace(' ', '_')}.pdf`, caption: `Here is your financial report for ${monthName}.` });
    return { success: true, message: "Transaction report has been sent." };
}

async function generateInventoryReport(args, collections, senderId, sock) {
    const { productsCollection, inventoryLogsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: senderId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const products = await productsCollection.find({ userId: senderId }).toArray();
    const logs = await inventoryLogsCollection.find({ userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).sort({ createdAt: 1 }).toArray();

    if (products.length === 0) {
        return { success: false, message: "No products to report on." };
    }

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const pdfBuffer = await ReportGenerators.createInventoryReportPDF(products, logs, monthName, user);
    await sock.sendMessage(senderId, { document: pdfBuffer, mimetype: 'application/pdf', fileName: `Inventory_Report_${monthName.replace(' ', '_')}.pdf`, caption: `Here is your inventory and profit report.` });
    return { success: true, message: "Inventory report has been sent." };
}

async function generatePnLReport(args, collections, senderId, sock) {
    const { transactionsCollection, inventoryLogsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: senderId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const income = await transactionsCollection.aggregate([ { $match: { userId: senderId, type: 'income', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, { $group: { _id: null, total: { $sum: '$amount' } } } ]).toArray();
    const totalRevenue = income[0]?.total || 0;
    const expensesResult = await transactionsCollection.find({ userId: senderId, type: 'expense', createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).toArray();

    if (totalRevenue === 0 && expensesResult.length === 0) {
        return { success: false, message: "No financial activity found for this month." };
    }

    const cogsLogs = await inventoryLogsCollection.aggregate([ { $match: { userId: senderId, type: 'sale', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'productInfo' } }, { $unwind: '$productInfo' }, { $group: { _id: null, total: { $sum: { $multiply: [ { $abs: '$quantityChange' }, '$productInfo.cost' ] } } } } ]).toArray();
    const cogs = cogsLogs[0]?.total || 0;
    const expensesByCategory = {};
    expensesResult.forEach(exp => {
        const category = exp.category || 'Uncategorized';
        if (!expensesByCategory[category]) expensesByCategory[category] = 0;
        expensesByCategory[category] += exp.amount;
    });

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const pdfBuffer = await ReportGenerators.createPnLReportPDF({ totalRevenue, cogs, expensesByCategory }, monthName, user);
    await sock.sendMessage(senderId, { document: pdfBuffer, mimetype: 'application/pdf', fileName: `P&L_Report_${monthName.replace(' ', '_')}.pdf`, caption: `Here is your Profit & Loss Statement.` });
    return { success: true, message: "P&L report has been sent." };
}

const availableTools = { logTransaction, addProduct, setOpeningBalance, getInventory, getMonthlySummary, generateTransactionReport, generateInventoryReport, generatePnLReport };

// --- Main Message Handler ---
export async function handleMessage(sock, msg, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = msg.key.remoteJid;
    const messageText = msg.message?.conversation?.trim();

    if (!messageText) return;

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
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_balance_confirmation' } });
                await sock.sendMessage(senderId, { text: `Perfect. Currency set to *${currency}*.\n\nFinally, let's record your current inventory (Opening Balance).\n\nAre you ready to add your products now? (Yes/No)` });
                return;
            case 'awaiting_balance_confirmation':
                if (messageText.toLowerCase().includes('yes')) {
                    await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_opening_balance' } });
                    await sock.sendMessage(senderId, { text: `Excellent! Please send your product list in the format:\n\n*<Name> <Cost> <Price> <Stock>*` });
                } else {
                    await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } });
                    await sock.sendMessage(senderId, { text: `No problem. Setup is complete! You can set your opening balance later by telling me "set my opening balance".\n\nI'm ready to help you manage your business!` });
                }
                return;
            case 'awaiting_opening_balance':
                const parsedProducts = parseProductLines(messageText);
                if (parsedProducts.length > 0) {
                    const resultText = await setOpeningBalance({ products: parsedProducts }, collections, senderId);
                    await sock.sendMessage(senderId, { text: resultText });
                    await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } });
                } else {
                    await sock.sendMessage(senderId, { text: "I couldn't understand that format. Please try again in the format: `<Name> <Cost> <Price> <Stock>`" });
                }
                return;
        }
    }
    
    try {
        const history = conversation ? conversation.history : [];
        const systemInstruction = `You are 'Smart Accountant', a professional, confident, and friendly AI bookkeeping assistant. Follow these rules with absolute priority: 1. **Use Tools for All Data Questions:** If a user asks a question about their specific financial or inventory data (e.g., "what are my expenses?", "how many soaps do I have?"), you MUST use a tool to get the answer. Do not answer from your own knowledge or provide placeholder text like '[Amount]'. Your primary job is to call the correct function. 2. **Never Explain Yourself:** Do not mention your functions, code, or that you are an AI. Never explain your limitations or internal thought process (e.g., do not say "I cannot access data"). Speak as if you are the one performing the action. 3. **Stay Within Abilities:** ONLY perform actions defined in the available tools. If asked to do something else (like send an email or browse the web), politely state your purpose is bookkeeping. 4. **Use the Right Tool:** For simple questions about totals (e.g., "what are my expenses?"), use 'getMonthlySummary'. For requests to "export", "download", "send the file", or receive a "PDF report", use the appropriate 'generate...Report' tool. 5. **Be Confident & Concise:** When a tool is called, assume it was successful. Announce the result confidently and briefly. 6. **Stay On Topic:** If asked about things unrelated to bookkeeping (e.g., science, general knowledge), politely guide the user back to your purpose.`;
        const chatHistoryForAPI = [ { role: "user", parts: [{ text: systemInstruction }] }, { role: "model", parts: [{ text: "Understood. I will follow these rules." }] }, ...history ];
        const chat = model.startChat({ tools: [{ functionDeclarations: tools }], history: chatHistoryForAPI });

        // STEP 1: Send user message to AI
        let result = await chat.sendMessage(messageText);
        let response = result.response;

        // STEP 2: Check if AI wants to call a function and loop until it doesn't
        while (response.functionCalls() && response.functionCalls().length > 0) {
            const functionCalls = response.functionCalls();
            console.log("AI wants to call tools:", functionCalls.map(c => c.name));
            
            const functionResponses = [];

            for (const call of functionCalls) {
                const selectedTool = availableTools[call.name];
                if (selectedTool) {
                    const resultData = await selectedTool(call.args, collections, senderId, sock);
                    functionResponses.push({
                        name: call.name,
                        response: resultData,
                    });
                }
            }
            
            // STEP 3: Send function results back to AI
            result = await chat.sendMessage(JSON.stringify({ functionResponses }));
            response = result.response;
        }
        
        // STEP 4: Get final AI text response and send to user
        const finalResponse = response.text().replace(/\[.*?\]/g, '').trim();
        if (finalResponse) {
            await sock.sendMessage(senderId, { text: finalResponse });
        }

        const updatedHistory = await chat.getHistory();
        const userFacingHistory = updatedHistory.slice(2);
        const prunedHistory = userFacingHistory.slice(-10); 
        await conversationsCollection.updateOne({ userId: senderId }, { $set: { history: prunedHistory, updatedAt: new Date() } }, { upsert: true });

    } catch (error) {
        console.error("Error in AI message handler:", error);
        await sock.sendMessage(senderId, { text: "Sorry, I encountered an error." });
    }
}

async function updateStockAfterSale(description, collections, senderId) {
    const { productsCollection, inventoryLogsCollection } = collections;
    const saleRegex = /(?:sale of|sold)\s*(\d+)x?\s*(.+)/i;
    const match = description.match(saleRegex);

    if (match) {
        const quantitySold = parseInt(match[1], 10);
        const productNameQuery = match[2].trim();
        const searchWords = productNameQuery.split(' ').map(word => new RegExp(word, 'i'));
        const product = await productsCollection.findOne({ userId: senderId, productName: { $all: searchWords } });
        if (!product) return null;
        await productsCollection.updateOne({ _id: product._id }, { $inc: { stock: -quantitySold } });
        await inventoryLogsCollection.insertOne({ userId: senderId, productId: product._id, type: 'sale', quantityChange: -quantitySold, notes: description, createdAt: new Date() });
        return product.productName;
    }
    return null;
}

function parseProductLines(text) {
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const products = [];
    for (const line of lines) {
        const parts = line.trim().split(' ');
        if (parts.length < 4) continue;
        const stock = parseInt(parts.pop(), 10);
        const price = parseFloat(parts.pop());
        const cost = parseFloat(parts.pop());
        const productName = parts.join(' ');
        if (!isNaN(cost) && !isNaN(price) && !isNaN(stock)) {
            products.push({ productName, cost, price, stock });
        }
    }
    return products;
}
