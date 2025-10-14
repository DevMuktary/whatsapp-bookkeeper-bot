import { ObjectId } from 'mongodb';

/**
 * Logs a sale of a product, updates inventory, and creates income/COGS transactions.
 * Now fully conversational and accepts detailed arguments from the AI.
 */
export async function logSale(args, collections, senderId) {
    const { transactionsCollection, productsCollection, inventoryLogsCollection } = collections;
    // UPDATED: Destructure all the new fields from the AI
    const { customerName, productName, unitsSold, amount, date, saleType } = args;

    // A small check to ensure core data is present
    if (!productName || !unitsSold || !amount) {
        return { success: false, message: "I'm missing some key details. I need at least a product name, the number of units sold, and the total amount." };
    }

    try {
        const product = await productsCollection.findOne({ 
            userId: senderId, 
            productName: { $regex: new RegExp(`^${productName}$`, "i") } 
        });

        if (!product) {
            return { success: false, message: `I couldn't find a product named *${productName}* in your inventory. You can add it using the 'Add New Stock' option.` };
        }

        if (product.stock < unitsSold) {
            return { 
                success: false, 
                message: `There isn't enough stock for *${productName}*. You only have ${product.stock} units, but you're trying to sell ${unitsSold}.` 
            };
        }

        // NEW: Handle natural dates from the AI, with a fallback to now.
        const transactionDate = date ? new Date(date) : new Date();

        // 1. Log Income Transaction with richer details
        await transactionsCollection.insertOne({
            userId: senderId,
            type: 'income',
            amount: amount,
            description: `Sale of ${unitsSold} x ${product.productName} to ${customerName || 'customer'}`,
            category: 'Sales',
            saleType: saleType || 'cash', // Default to cash if not specified
            customerName: customerName,
            createdAt: transactionDate
        });

        // 2. Calculate and Log Cost of Goods Sold (COGS) Expense
        const costOfSale = product.cost * unitsSold;
        if (costOfSale > 0) {
            await transactionsCollection.insertOne({
                userId: senderId,
                type: 'expense',
                amount: costOfSale,
                description: `Cost of Goods for ${unitsSold} x ${product.productName}`,
                category: 'Cost of Goods Sold',
                createdAt: transactionDate
            });
        }

        // 3. Update Inventory Stock
        // MAPPED: 'unitsSold' is the conversational term, 'stock' is the database field.
        await productsCollection.updateOne({ _id: product._id }, { $inc: { stock: -unitsSold } });

        // 4. Create Inventory Log
        await inventoryLogsCollection.insertOne({
            userId: senderId,
            productId: product._id,
            type: 'sale',
            quantityChange: -unitsSold,
            notes: `Sold ${unitsSold} units to ${customerName || 'customer'}`,
            createdAt: transactionDate
        });

        console.log(`Sale processed for ${unitsSold} x ${product.productName}. Stock updated.`);
        return { success: true, message: `✅ Got it! I've successfully recorded the sale of ${unitsSold} x *${product.productName}* for ${amount}.` };

    } catch (error) {
        console.error('Error in logSale function:', error);
        return { success: false, message: 'An unexpected error occurred while processing the sale.' };
    }
}

/**
 * Logs a generic expense transaction.
 * Now accepts specific fields from the AI.
 */
export async function logTransaction(args, collections, senderId) {
    const { transactionsCollection } = collections;
    // UPDATED: Use new, clearer field names from the AI.
    const { date, expenseType, amount, description } = args;

    try {
        const transactionDate = date ? new Date(date) : new Date();
        await transactionsCollection.insertOne({ 
            userId: senderId, 
            type: 'expense', 
            amount, 
            description: description || expenseType, // Use expenseType as description if none is provided
            category: expenseType || 'Uncategorized', // MAPPED: 'expenseType' is the conversational term
            createdAt: transactionDate 
        });
        return { success: true, message: `✅ Expense logged! I've recorded an expense of ${amount} for *${expenseType}*.` };
    } catch (error) {
        console.error('Error logging transaction:', error);
        return { success: false, message: 'Failed to log the expense.' };
    }
}

/**
 * Adds one or more products to the inventory.
 * Now uses the new field names from the AI.
 */
export async function addProduct(args, collections, senderId) {
    const { productsCollection, inventoryLogsCollection } = collections;
    // This function is designed to receive an array of products
    const { products } = args;
    let addedProductNames = [];
    
    try {
        for (const product of products) {
            // UPDATED: Use the new conversational field names
            const { productName, openingBalance, costPrice, sellingPrice } = product;

            // MAPPED: Map conversational names to database schema names
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
            const productId = doc._id;

            await inventoryLogsCollection.insertOne({ 
                userId: senderId, 
                productId: productId, 
                type: result.upsertedId ? 'initial_stock' : 'purchase', 
                quantityChange: stockToAdd, 
                notes: result.upsertedId ? `Product '${productName}' created.` : `Added ${stockToAdd} units of stock.`, 
                createdAt: new Date() 
            });
            
            addedProductNames.push(productName);
        }
        return { success: true, message: `✅ Done! I've successfully added *${addedProductNames.join(', ')}* to your inventory.` };
    } catch (error) {
        console.error('Error adding product:', error);
        return { success: false, message: 'Failed to add the product(s) to your inventory.' };
    }
}

/**
 * Retrieves a list of all products in the user's inventory.
 * No changes needed here.
 */
export async function getInventory(args, collections, senderId) {
    const { productsCollection, usersCollection } = collections;
    
    try {
        const user = await usersCollection.findOne({ userId: senderId });
        const products = await productsCollection.find({ userId: senderId }).sort({ productName: 1 }).toArray();
        
        if (products.length === 0) {
            return { success: false, message: "You don't have any products in your inventory yet." };
        }
        
        const inventoryList = products.map(p => `*${p.productName}* - Stock: ${p.stock}, Price: ${p.price}`).join('\n');
        return { success: true, message: `Here is your current inventory:\n\n${inventoryList}` };
    } catch (error) {
        console.error('Error getting inventory:', error);
        return { success: false, message: 'Failed to retrieve inventory.' };
    }
}

/**
 * Gets a quick text summary of finances for the current month.
 * No changes needed here.
 */
export async function getMonthlySummary(args, collections, senderId) {
    const { transactionsCollection, usersCollection } = collections;
    
    try {
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
        console.error('Error getting monthly summary:', error);
        return { success: false, message: 'I had trouble generating your monthly summary.' };
    }
}
