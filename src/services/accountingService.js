import { ObjectId } from 'mongodb';

/**
 * Logs a sale of a product, updates inventory, and creates income/COGS transactions.
 * Includes stock validation.
 */
export async function logSale(args, collections, senderId) {
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

        // --- 🔒 SECURITY FIX: STOCK VALIDATION ---
        if (product.stock < quantitySold) {
            return { 
                success: false, 
                message: `Not enough stock for "${productName}". You have ${product.stock} units, but tried to sell ${quantitySold}.` 
            };
        }
        // --- END OF FIX ---

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

/**
 * Logs a generic income or expense transaction.
 */
export async function logTransaction(args, collections, senderId) {
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

/**
 * Adds or updates products in the inventory.
 */
export async function addProduct(args, collections, senderId) {
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

            const productId = result.upsertedId ? result.upsertedId : (await productsCollection.findOne({ userId: senderId, productName: { $regex: new RegExp(`^${productName}$`, "i") } }))._id;

            await inventoryLogsCollection.insertOne({ 
                userId: senderId, 
                productId: productId, 
                type: result.upsertedId ? 'initial_stock' : 'purchase', 
                quantityChange: stock, 
                notes: result.upsertedId ? 'Product created' : 'Added new stock', 
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

/**
 * Sets the opening balance by calling addProduct.
 */
export async function setOpeningBalance(args, collections, senderId) {
    try {
        // This function is just an alias for addProduct,
        // but we keep it for semantic clarity in the AI tools.
        const result = await addProduct(args, collections, senderId);
        return { ...result, message: "Opening balance set." };
    } catch (error) {
        console.error('Error setting opening balance:', error);
        return { success: false, message: 'Failed to set opening balance' };
    }
}

/**
 * Retrieves a list of all products in the user's inventory.
 */
export async function getInventory(args, collections, senderId) {
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

/**
 * Gets a quick text summary of finances for the current month.
 */
export async function getMonthlySummary(args, collections, senderId) {
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
