import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const productsCollection = () => getDB().collection('products');
const inventoryLogsCollection = () => getDB().collection('inventory_logs');

export async function findProductByName(userId, productName) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    return await productsCollection().findOne(query);
}

export async function upsertProduct(userId, productName, quantityAdded, newCostPrice, sellingPrice, reorderLevel = 5) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    
    const existingProduct = await productsCollection().findOne(query);
    
    let finalCostPrice = newCostPrice;

    if (existingProduct) {
        const oldQty = existingProduct.quantity || 0;
        const oldCost = existingProduct.costPrice || 0;
        const totalQty = oldQty + quantityAdded;

        if (totalQty > 0 && quantityAdded > 0) {
            const totalValue = (oldQty * oldCost) + (quantityAdded * newCostPrice);
            finalCostPrice = totalValue / totalQty;
            finalCostPrice = Math.round(finalCostPrice * 100) / 100;
        } else if (quantityAdded === 0) {
             finalCostPrice = newCostPrice;
        }
    }

    const update = {
        $set: { 
            userId: validUserId, 
            productName, 
            costPrice: finalCostPrice, 
            sellingPrice, 
            reorderLevel, 
            updatedAt: new Date() 
        },
        $inc: { quantity: quantityAdded },
        $setOnInsert: { createdAt: new Date() }
    };

    const result = await productsCollection().findOneAndUpdate(
        query, 
        update, 
        { upsert: true, returnDocument: 'after' }
    );
    
    if (quantityAdded !== 0) {
        await inventoryLogsCollection().insertOne({
            userId: validUserId,
            productId: result._id,
            quantityChange: quantityAdded,
            reason: 'STOCK_ADJUSTMENT',
            costAtTime: finalCostPrice, 
            createdAt: new Date()
        });
    }
    
    return result;
}

export async function updateStock(productId, quantityChange, reason, linkedTransactionId) {
    const validProdId = typeof productId === 'string' ? new ObjectId(productId) : productId;
    
    const filter = { _id: validProdId };
    
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
        const product = await productsCollection().findOne({ _id: validProdId });
        if (product && product.quantity < Math.abs(quantityChange)) {
            throw new Error(`Insufficient stock for "${product.productName}". Available: ${product.quantity}`);
        }
        throw new Error('Product not found for stock update.');
    }

    await inventoryLogsCollection().insertOne({
        userId: updatedProduct.userId,
        productId: validProdId,
        quantityChange,
        reason,
        linkedTransactionId: typeof linkedTransactionId === 'string' ? new ObjectId(linkedTransactionId) : linkedTransactionId,
        createdAt: new Date()
    });

    return updatedProduct;
}

export async function getAllProducts(userId) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    return await productsCollection().find({ userId: validUserId }).sort({ productName: 1 }).toArray();
}
