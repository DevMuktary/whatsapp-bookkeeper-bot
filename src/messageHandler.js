import { generateMonthlyReportPDF, generateInventoryReportPDF } from './reportGenerator.js';
import { ObjectId } from 'mongodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [
  {
    name: 'logTransaction',
    description: 'Logs a new income or expense transaction. Also use for sales of products.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'The type of transaction, either "income" or "expense".' },
        amount: { type: 'number', description: 'The numerical amount of the transaction.' },
        description: { type: 'string', description: 'A detailed description of the transaction, including product names and quantities if it is a sale.' },
      },
      required: ['type', 'amount', 'description'],
    },
  },
  {
    name: 'addProduct',
    description: 'Adds one or more new products to the user\'s inventory.',
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
    name: 'getInventory',
    description: 'Retrieves and displays a list of all products in the user\'s inventory.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'generateTransactionReport',
    description: 'Generates and sends a PDF report of all financial transactions for the current month.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'generateInventoryReport',
    description: 'Generates and sends a detailed PDF report of inventory, sales, and profit for the current month.',
    parameters: { type: 'object', properties: {} },
  },
];

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest",
  tool_config: { function_calling_config: { mode: "any" } }
});

async function logTransaction(args, collections, senderId) {
    const { transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
    const { type, amount, description } = args;

    let replyMessage = '✅ Transaction logged successfully!';
    if (type === 'income') {
        const productSold = await updateStockAfterSale(description, { productsCollection, inventoryLogsCollection }, senderId);
        if (productSold) {
            replyMessage += `\n_Stock for "${productSold}" has been updated._`;
        }
    }
    
    await transactionsCollection.insertOne({ userId: senderId, type, amount, description, createdAt: new Date() });
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

async function getInventory(args, collections, senderId) {
    const { productsCollection } = collections;
    const products = await productsCollection.find({ userId: senderId }).sort({ productName: 1 }).toArray();
    if (products.length === 0) {
        return "You have no products in your inventory.";
    }
    let inventoryList = "📦 *Your Inventory*\n\n*Name | Price | Stock*\n---------------------\n";
    products.forEach(p => {
        inventoryList += `${p.productName} | ₦${p.price.toLocaleString()} | ${p.stock}\n`;
    });
    return inventoryList;
}

async function generateTransactionReport(args, collections, senderId, sock) {
    const { transactionsCollection } = collections;
    await sock.sendMessage(senderId, { text: 'Generating your monthly transaction report... 📄' });
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
    const pdfBuffer = await generateMonthlyReportPDF(transactions, monthName);

    await sock.sendMessage(senderId, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `Financial_Report_${monthName.replace(' ', '_')}.pdf`,
        caption: `Here is your financial report for ${monthName}.`
    });
    return null;
}

async function generateInventoryReport(args, collections, senderId, sock) {
    const { productsCollection, inventoryLogsCollection } = collections;
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
        return "You have no products to report on.";
    }

    const monthName = startOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const pdfBuffer = await generateInventoryReportPDF(products, logs, monthName);
    
    await sock.sendMessage(senderId, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `Inventory_Report_${monthName.replace(' ', '_')}.pdf`,
        caption: `Here is your inventory and profit report for ${monthName}.`
    });
    return null;
}

const availableTools = {
    logTransaction,
    addProduct,
    getInventory,
    generateTransactionReport,
    generateInventoryReport,
};

export async function handleMessage(sock, msg, collections) {
    const { usersCollection, conversationsCollection } = collections;
    const senderId = msg.key.remoteJid;
    const messageText = msg.message?.conversation?.trim();

    if (!messageText) return;

    let user = await usersCollection.findOne({ userId: senderId });
    if (!user) {
        await usersCollection.insertOne({ userId: senderId, createdAt: new Date() });
        const welcomeMessage = `👋 Welcome to your AI Bookkeeping Assistant!\n\nI'm now powered by an advanced AI with memory. You can speak to me in plain English.\n\n*Try things like:*\n- "I sold two phone chargers for 10000"\n- "Add a product called Soap, it cost me 300, I sell it for 500, and I have 50 in stock"\n- "What's in my inventory?"\n- "Export my profit report for this month"`;
        await sock.sendMessage(senderId, { text: welcomeMessage });
        return;
    }

    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        const history = conversation ? conversation.history : [];

        const chat = model.startChat({ 
            tools: [{ functionDeclarations: tools }],
            history: history 
        });

        const result = await chat.sendMessage(messageText);
        const call = result.response.functionCalls()?.[0];

        if (call) {
            const selectedTool = availableTools[call.name];
            if (selectedTool) {
                console.log(`AI is calling tool: ${call.name} with args:`, call.args);
                const resultText = await selectedTool(call.args, collections, senderId, sock);
                if (resultText) {
                    await sock.sendMessage(senderId, { text: resultText });
                }
            } else {
                await sock.sendMessage(senderId, { text: `Sorry, I recognized a command "${call.name}" but I don't know how to perform it.` });
            }
        } else {
            const textResponse = result.response.text();
            await sock.sendMessage(senderId, { text: textResponse });
        }

        const updatedHistory = await chat.getHistory();
        // Limit history to the last 10 turns to prevent it from getting too large
        const prunedHistory = updatedHistory.slice(-10); 
        await conversationsCollection.updateOne(
            { userId: senderId },
            { $set: { history: prunedHistory, updatedAt: new Date() } },
            { upsert: true }
        );

    } catch (error) {
        console.error("Error in AI message handler:", error);
        await sock.sendMessage(senderId, { text: "Sorry, I encountered an error trying to understand that." });
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
