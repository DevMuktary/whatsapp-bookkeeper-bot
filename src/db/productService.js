import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const productsCollection = () => getDB().collection('products');
const inventoryLogsCollection = () => getDB().collection('inventory_logs');

export async function findProductByName(userId, productName) {
    const query = { userId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    return await productsCollection().findOne(query);
}

// [UPDATED] Implements Weighted Average Cost (AVCO)
export async function upsertProduct(userId, productName, quantityAdded, newCostPrice, sellingPrice, reorderLevel = 5) {
    const query = { userId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    
    // 1. Fetch existing product to calculate Average Cost
    const existingProduct = await productsCollection().findOne(query);
    
    let finalCostPrice = newCostPrice;

    // Calculate Weighted Average Cost
    // Formula: ((OldQty * OldCost) + (AddedQty * NewCost)) / TotalQty
    if (existingProduct) {
        const oldQty = existingProduct.quantity || 0;
        const oldCost = existingProduct.costPrice || 0;
        const totalQty = oldQty + quantityAdded;

        if (totalQty > 0 && quantityAdded > 0) {
            const totalValue = (oldQty * oldCost) + (quantityAdded * newCostPrice);
            finalCostPrice = totalValue / totalQty;
            
            // Round to 2 decimal places for cleanliness
            finalCostPrice = Math.round(finalCostPrice * 100) / 100;
        } else if (quantityAdded === 0) {
             // If just updating price details without adding stock, keep the old cost or update if desired?
             // Usually, we only update Cost Price if we are adding new stock with a new cost.
             // If quantityAdded is 0, we assume user might be manually correcting the cost.
             finalCostPrice = newCostPrice;
        }
    }

    const update = {
        $set: { 
            userId, 
            productName, // Updates name casing if changed
            costPrice: finalCostPrice, 
            sellingPrice, 
            reorderLevel, 
            updatedAt: new Date() 
        },
        $inc: { quantity: quantityAdded },
        $setOnInsert: { createdAt: new Date() }
    };

    // Upsert = Update if exists, Insert if new
    const result = await productsCollection().findOneAndUpdate(
        query, 
        update, 
        { upsert: true, returnDocument: 'after' }
    );
    
    // Log the movement
    if (quantityAdded !== 0) {
        await inventoryLogsCollection().insertOne({
            userId,
            productId: result._id,
            quantityChange: quantityAdded,
            reason: 'STOCK_ADJUSTMENT',
            costAtTime: finalCostPrice, // [NEW] Track cost at time of movement
            createdAt: new Date()
        });
    }
    
    return result;
}

export async function updateStock(productId, quantityChange, reason, linkedTransactionId) {
    const filter = { _id: productId };
    
    // Safety Check: If reducing stock, ensure we have enough.
    if (quantityChange < 0) {
        filter.quantity = { $gte: Math.abs(quantityChange) };
    }

    const updatedProduct = await productsCollection().findOneAndUpdate(
        filter,
        { 
            $inc: { quantity: quantityChange },
            $set: { updatedAt: new Date() }
        },
        { returnDocument: 'after' }
    );

    if (!updatedProduct) {
        const product = await productsCollection().findOne({ _id: productId });
        if (product && product.quantity < Math.abs(quantityChange)) {
            throw new Error(`Insufficient stock for "${product.productName}". Available: ${product.quantity}`);
        }
        throw new Error('Product not found for stock update.');
    }

    await inventoryLogsCollection().insertOne({
        userId: updatedProduct.userId,
        productId,
        quantityChange,
        reason,
        linkedTransactionId,
        createdAt: new Date()
    });

    return updatedProduct;
}

export async function getAllProducts(userId) {
    return await productsCollection().find({ userId }).sort({ productName: 1 }).toArray();
}
