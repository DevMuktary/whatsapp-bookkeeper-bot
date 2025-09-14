import { generateMonthlyReportPDF, generateInventoryReportPDF, generatePnLReportPDF } from './reportGenerator.js';
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

// --- Specialist Functions ---

async function logTransaction(args, collections, senderId) {
    const { transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
    const { type, amount, description, category = 'Uncategorized' } = args;

    let replyMessage = `✅ Transaction logged successfully!`;
    if (type === 'expense') {
        replyMessage = `✅ Expense logged under category: *${category}*`;
    }

    if (type === 'income') {
        const productSold = await updateStockAfterSale(description, { productsCollection, inventoryLogsCollection }, senderId);
        if (productSold) {
            replyMessage += `\n_Stock for "${productSold}" has been updated._`;
        }
    }
    
    await transactionsCollection.insertOne({ userId: senderId, type, amount, description, category, createdAt: new Date() });
    return replyMessage;
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
    return `✅ Successfully added ${addedProducts.length} product(s): ${addedProducts.join(', ')}`;
}

async function setOpeningBalance(args, collections, senderId) {
    const resultText = await addProduct(args, collections, senderId);
    return resultText + "\n\nYour opening balance has been set successfully!";
}

async function getInventory(args, collections, senderId) {
    const { productsCollection } = collections;
    const products = await productsCollection.find({ userId: senderId }).sort({ productName: 1 }).toArray();
    if (products.length === 0) {
        return "You have no products in your inventory. You can set your opening balance by saying 'set my opening balance'.";
    }
    let inventoryList = "📦 *Your Inventory*\n\n*Name | Price | Stock*\n---------------------\n";
    products.forEach(p => {
        inventoryList += `${p.productName} | ₦${p.price.toLocaleString()} | ${p.stock}\n`;
    });
    return inventoryList;
}

async function getMonthlySummary(args, collections, senderId) {
    const { transactionsCollection } = collections;
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

    return `📊 *Financial Summary for ${monthName}*\n\n*Total Income:* ₦${totalIncome.toLocaleString()}\n*Total Expense:* ₦${totalExpense.toLocaleString()}\n---------------------\n*Net Balance:* *₦${net.toLocaleString()}*`;
}

async function generateTransactionReport(args, collections, senderId) {
    const { transactionsCollection, usersCollection } = collections;
    const user = await usersCollection.findOne({ userId: senderId });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    const transactions = await transactionsCollection.find({ 
        userId: senderId, 
        createdAt: { $gte: startOfMonth, $lte: endOfMonth } 
    }).sort({ createdAt: 1 }).toArray();

    if (transactions.length === 0) {
        return "You have no transactions this month to export.";
    }

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const pdfBuffer = await generateMonthlyReportPDF(transactions, monthName, user);

    return {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `Financial_Report_${monthName.replace(' ', '_')}.pdf`,
        caption: `Here is your complete financial report for ${monthName}.`
    };
}

async function generateInventoryReport(args, collections, senderId) {
    const { productsCollection, inventoryLogsCollection, usersCollection } = collections;
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
        return "You have no products to report on.";
    }

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const pdfBuffer = await generateInventoryReportPDF(products, logs, monthName, user);
    
    return {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `Inventory_Report_${monthName.replace(' ', '_')}.pdf`,
        caption: `Here is your complete inventory and profit report for ${monthName}.`
    };
}

async function generatePnLReport(args, collections, senderId) {
    const { transactionsCollection, inventoryLogsCollection, usersCollection } = collections;
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
        return "You have no financial activity recorded for this month. I cannot generate a Profit & Loss statement.";
    }

    const cogsLogs = await inventoryLogsCollection.aggregate([
        { $match: { userId: senderId, type: 'sale', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } },
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'productInfo' } },
        { $unwind: '$productInfo' },
        { $group: { _id: null, total: { $sum: { $multiply: [ { $abs: '$quantityChange' }, '$productInfo.cost' ] } } } }
    ]).toArray();
    const cogs = cogsLogs[0]?.total || 0;

    const expensesByCategory = {};
    expensesResult.forEach(exp => {
        const category = exp.category || 'Uncategorized';
        if (!expensesByCategory[category]) {
            expensesByCategory[category] = 0;
        }
        expensesByCategory[category] += exp.amount;
    });

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const pdfBuffer = await generatePnLReportPDF({ totalRevenue, cogs, expensesByCategory }, monthName, user);

    return {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `P&L_Report_${monthName.replace(' ', '_')}.pdf`,
        caption: `Here is your Profit & Loss Statement for ${monthName}.`
    };
}


const availableTools = {
    logTransaction,
    addProduct,
    setOpeningBalance,
    getInventory,
    getMonthlySummary,
    generateTransactionReport,
    generateInventoryReport,
    generatePnLReport,
};

async function processMessageWithAI(text, collections, senderId, sock) {
    const { conversationsCollection } = collections;
    const conversation = await conversationsCollection.findOne({ userId: senderId });
    let history = conversation ? conversation.history : [];

    const systemInstruction = `You are 'Smart Accountant', a professional, confident, and friendly AI bookkeeping assistant. Follow these rules strictly:
1.  **Never Explain Yourself:** Do not mention your functions, code, or that you are an AI. Never explain your limitations or internal thought process (e.g., do not say "I cannot access data"). Speak as if you are the one performing the action.
2.  **Stay Within Abilities:** ONLY perform actions defined in the available tools. If asked to do something else (like send an email or browse the web), politely decline and state your purpose is bookkeeping.
3.  **Use the Right Tool:** For simple questions about totals (e.g., "what are my expenses?"), use the 'getMonthlySummary' tool. For requests to "export", "download", "send the file", or receive a "PDF report", use the appropriate 'generate...Report' tool.
4.  **Be Confident & Concise:** When a tool is called, assume it was successful. Announce the result confidently and briefly.
5.  **Stay On Topic:** If asked about things unrelated to bookkeeping (e.g., science, general knowledge), politely guide the user back to your purpose.`;
    
    const chatHistoryForAPI = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "Understood. I am Smart Accountant, ready to assist." }] },
        ...history
    ];

    const chat = model.startChat({ 
        tools: [{ functionDeclarations: tools }],
        history: chatHistoryForAPI
    });

    const result = await chat.sendMessage(text);
    const call = result.response.functionCalls()?.[0];

    if (call) {
        const selectedTool = availableTools[call.name];
        if (selectedTool) {
            console.log(`AI is calling tool: ${call.name} with args:`, call.args);
            await sock.sendMessage(senderId, { text: `Please give me a moment to process that...` });
            const resultData = await selectedTool(call.args, collections, senderId);

            if (typeof resultData === 'string') {
                await sock.sendMessage(senderId, { text: resultData });
            } else if (resultData && resultData.document) {
                await sock.sendMessage(senderId, { 
                    document: resultData.document,
                    mimetype: resultData.mimetype,
                    fileName: resultData.fileName,
                    caption: resultData.caption
                });
            }
        } else {
            await sock.sendMessage(senderId, { text: `Sorry, I don't know how to perform the action: "${call.name}".` });
        }
    } else {
        const textResponse = result.response.text();
        await sock.sendMessage(senderId, { text: textResponse });
    }

    const updatedHistory = await chat.getHistory();
    const userFacingHistory = updatedHistory.slice(2);
    const prunedHistory = userFacingHistory.slice(-10); 
    await conversationsCollection.updateOne(
        { userId: senderId },
        { $set: { history: prunedHistory, updatedAt: new Date() } },
        { upsert: true }
    );
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

export async function handleMessage(sock, msg, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = msg.key.remoteJid;
    const messageText = msg.message?.conversation?.trim();

    if (!messageText) return;

    let user = await usersCollection.findOne({ userId: senderId });
    let conversation = await conversationsCollection.findOne({ userId: senderId });

    if (!user) {
        await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
        await conversationsCollection.updateOne(
            { userId: senderId },
            { $set: { state: 'awaiting_store_name', history: [] } },
            { upsert: true }
        );
        const welcomeMessage = `👋 Welcome to your new AI Bookkeeping Assistant!\n\nTo get started, please tell me the name of your business or store.`;
        await sock.sendMessage(senderId, { text: welcomeMessage });
        return;
    }
    
    switch (conversation?.state) {
        case 'awaiting_store_name':
            await usersCollection.updateOne({ userId: senderId }, { $set: { storeName: messageText } });
            await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_currency' } });
            await sock.sendMessage(senderId, { text: `Great! Your store name is set to *${messageText}*.\n\nNow, please select your primary currency (e.g., NGN, USD, GHS, KES).` });
            return;
        
        case 'awaiting_currency':
            const currency = messageText.toUpperCase();
            await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currency } });
            await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_balance_confirmation' } });
            await sock.sendMessage(senderId, { text: `Perfect. Currency set to *${currency}*.\n\nFinally, to get started accurately, we need to record your current inventory (Opening Balance).\n\nAre you ready to add your products now? (Yes/No)` });
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
    
    try {
        await processMessageWithAI(messageText, collections, senderId, sock);
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

        const product = await productsCollection.findOne({ 
            userId: senderId, 
            productName: { $all: searchWords } 
        });

        if (!product) return null;

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
