import { ObjectId } from 'mongodb';

/**
 * Logs a sale of a product, updates inventory, and creates income/COGS transactions.
 */
export async function logSale(args, collections, senderId) {
    try {
        const { transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
        // Acknowledges the new 'userConfirmed' argument
        const { customerName, productName, unitsSold, amount, date, saleType, userConfirmed } = args;

        if (!productName || !unitsSold || !amount) {
            return { success: false, message: "Missing key details: product name, units sold, and amount are required." };
        }

        const product = await productsCollection.findOne({ 
            userId: senderId, 
            productName: { $regex: new RegExp(`^${productName}$`, "i") } 
        });

        if (!product) {
            return { success: false, message: `I couldn't find a product named *${productName}*. Please add it to your stock first.` };
        }
        if (product.stock < unitsSold) {
            return { success: false, message: `Not enough stock for *${productName}*. You have ${product.stock}, but tried to sell ${unitsSold}.` };
        }

        const transactionDate = date ? new Date(date) : new Date();

        await transactionsCollection.insertOne({
            userId: senderId, type: 'income', amount: amount,
            description: `Sale of ${unitsSold} x ${product.productName} to ${customerName || 'customer'}`,
            category: 'Sales', saleType: saleType || 'cash', customerName: customerName,
            createdAt: transactionDate
        });

        const costOfSale = product.cost * unitsSold;
        if (costOfSale > 0) {
            await transactionsCollection.insertOne({
                userId: senderId, type: 'expense', amount: costOfSale,
                description: `Cost of Goods for ${unitsSold} x ${product.productName}`,
                category: 'Cost of Goods Sold', createdAt: transactionDate
            });
        }

        await productsCollection.updateOne({ _id: product._id }, { $inc: { stock: -unitsSold } });

        await inventoryLogsCollection.insertOne({
            userId: senderId, productId: product._id, type: 'sale',
            quantityChange: -unitsSold,
            notes: `Sold ${unitsSold} units to ${customerName || 'customer'}`,
            createdAt: transactionDate
        });

        console.log(`SUCCESS: Sale processed for ${unitsSold} x ${product.productName}.`);
        return { success: true, message: `✅ Got it! I've successfully recorded the sale of ${unitsSold} x *${product.productName}*.` };

    } catch (error) {
        console.error('CRITICAL ERROR in logSale:', error);
        return { success: false, message: 'A critical error occurred while trying to log the sale. I have notified the developers.' };
    }
}

/**
 * Logs a generic expense transaction.
 */
export async function logTransaction(args, collections, senderId) {
    try {
        const { transactionsCollection } = collections;
        // Acknowledges the new 'userConfirmed' argument
        const { date, expenseType, amount, description, userConfirmed } = args;

        const transactionDate = date ? new Date(date) : new Date();
        await transactionsCollection.insertOne({ 
            userId: senderId, type: 'expense', amount, 
            description: description || expenseType, 
            category: expenseType || 'Uncategorized', 
            createdAt: transactionDate 
        });

        console.log(`SUCCESS: Expense of ${amount} for ${expenseType} logged.`);
        return { success: true, message: `✅ Expense logged! I've recorded an expense of ${amount} for *${expenseType}*.` };
    } catch (error) {
        console.error('CRITICAL ERROR in logTransaction:', error);
        return { success: false, message: 'A critical error occurred while trying to log the expense. I have notified the developers.' };
    }
}

/**
 * Adds a SINGLE product to the inventory.
 */
export async function addProduct(args, collections, senderId) {
    try {
        const { productsCollection, inventoryLogsCollection } = collections;
        // Acknowledges the new 'userConfirmed' argument
        const { productName, openingBalance, costPrice, sellingPrice, userConfirmed } = args;

        if (!productName || openingBalance === undefined || costPrice === undefined || sellingPrice === undefined) {
             return { success: false, message: "Missing key details. I need a product name, opening balance, cost price, and selling price." };
        }

        const stockToAdd = openingBalance;
        const cost = costPrice;
        const price = sellingPrice;

        const result = await productsCollection.updateOne(
            { userId: senderId, productName: { $regex: new RegExp(`^${productName}$`, "i") } },
            { 
                $set: { cost, price }, 
                $inc: { stock: stockToAdd }, 
                $setOnInsert: { userId: senderId, productName, createdAt: new Date() } 
            },
            { upsert: true }
        );

        const doc = await productsCollection.findOne({ userId: senderId, productName: { $regex: new RegExp(`^${productName}$`, "i") } });
        if (!doc) {
             throw new Error("Failed to find or create the product document after upsert.");
        }
        const productId = doc._id;

        await inventoryLogsCollection.insertOne({ 
            userId: senderId, 
            productId: productId, 
            type: result.upsertedId ? 'initial_stock' : 'purchase', 
            quantityChange: stockToAdd, 
            notes: result.upsertedId ? `Product '${productName}' created.` : `Added ${stockToAdd} units of stock.`, 
            createdAt: new Date() 
        });
        
        console.log(`SUCCESS: Product '${productName}' added/updated.`);
        return { success: true, message: `✅ Done! I've successfully added *${productName}* to your inventory.` };
    } catch (error) {
        console.error('CRITICAL ERROR in addProduct:', error);
        return { success: false, message: 'A critical error occurred while trying to add the product. I have notified the developers.' };
    }
}


/**
 * Retrieves a list of all products in the user's inventory.
 */
export async function getInventory(args, collections, senderId) {
    try {
        const { productsCollection } = collections;
        
        const products = await productsCollection.find({ userId: senderId }).sort({ productName: 1 }).toArray();
        
        if (products.length === 0) {
            return { success: true, message: "You don't have any products in your inventory yet." };
        }
        
        const inventoryList = products.map(p => `*${p.productName}* - Stock: ${p.stock}, Price: ${p.price}`).join('\n');
        return { success: true, message: `Here is your current inventory:\n\n${inventoryList}` };
    } catch (error) {
        console.error('CRITICAL ERROR in getInventory:', error);
        return { success: false, message: 'A critical error occurred while trying to retrieve your inventory.' };
    }
}

/**
 * Gets a quick text summary of finances for the current month.
 */
export async function getMonthlySummary(args, collections, senderId) {
    try {
        const { transactionsCollection, usersCollection } = collections;
        
        const user = await usersCollection.findOne({ userId: senderId });
        const currency = user?.currency || 'NGN';
        const now = new Date();
        const monthName = now.toLocaleString('default', { month: 'long' });
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        
        const summary = await transactionsCollection.aggregate([
            { $match: { userId: senderId, createdAt: { $gte: startOfMonth } } }, 
            { $group: { _id: "$type", totalAmount: { $sum: "$amount" } } }
        ]).toArray();
        
        let totalIncome = 0, totalExpense = 0;
        summary.forEach(item => {
            if (item._id === 'income') totalIncome = item.totalAmount;
            if (item._id === 'expense') totalExpense = item.totalAmount;
        });
        
        const netProfit = totalIncome - totalExpense;
        const formattedIncome = new Intl.NumberFormat().format(totalIncome);
        const formattedExpense = new Intl.NumberFormat().format(totalExpense);
        const formattedNet = new Intl.NumberFormat().format(netProfit);

        return { 
            success: true, 
            message: `Here is your financial summary for *${monthName}*:\n\n💰 Total Income: *${currency} ${formattedIncome}*\n💸 Total Expenses: *${currency} ${formattedExpense}*\n\n📊 Net Profit: *${currency} ${formattedNet}*`
        };
    } catch (error) {
        console.error('CRITICAL ERROR in getMonthlySummary:', error);
        return { success: false, message: 'I had trouble generating your monthly summary.' };
    }
}
