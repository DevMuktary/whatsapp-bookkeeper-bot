import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const productsCollection = () => getDB().collection('products');
const inventoryLogsCollection = () => getDB().collection('inventory_logs');

export async function findProductByName(userId, productName) {
    const query = { userId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    return await productsCollection().findOne(query);
}

// [UPDATED] Added reorderLevel parameter (Default 5)
export async function upsertProduct(userId, productName, quantityAdded, costPrice, sellingPrice, reorderLevel = 5) {
    const filter = { userId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    const update = {
        $set: { 
            userId, 
            productName, 
            costPrice, 
            sellingPrice, 
            reorderLevel, // Saved to DB
            updatedAt: new Date() 
        },
        $inc: { quantity: quantityAdded },
        $setOnInsert: { createdAt: new Date() }
    };
    const result = await productsCollection().findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
    
    if (quantityAdded !== 0) {
        await inventoryLogsCollection().insertOne({
            userId,
            productId: result._id,
            quantityChange: quantityAdded,
            reason: 'STOCK_ADJUSTMENT',
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
