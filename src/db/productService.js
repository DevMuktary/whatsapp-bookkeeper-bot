import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
import { escapeRegex } from '../utils/helpers.js'; // [FIX] Import Helper

const productsCollection = () => getDB().collection('products');
const inventoryLogsCollection = () => getDB().collection('inventory_logs');

export async function findProductByName(userId, productName, options = {}) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    // [FIX] Escape regex to prevent crash
    const safeName = escapeRegex(productName.trim());
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${safeName}$`, 'i') } };
    return await productsCollection().findOne(query, options);
}

// [NEW] Fuzzy Search for "Did you mean...?"
export async function findProductFuzzy(userId, searchText) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    // [FIX] Escape regex here too
    const safeText = escapeRegex(searchText.trim());
    
    const query = { 
        userId: validUserId, 
        productName: { $regex: new RegExp(safeText, 'i') } 
    };
    return await productsCollection().find(query).limit(5).toArray();
}

export async function upsertProduct(userId, productName, quantityAdded, newCostPrice, sellingPrice, reorderLevel = 5) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const safeName = escapeRegex(productName.trim());
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${safeName}$`, 'i') } };
    
    // [FIX] Division by Zero Protection in Aggregation
    // Logic: If (CurrentQty + AddedQty) == 0, we cannot divide. Just use newCostPrice.
    
    const update = [
        {
            $set: {
                userId: validUserId,
                productName: productName.trim(), // Ensure clean name stored
                sellingPrice: sellingPrice,
                reorderLevel: reorderLevel,
                updatedAt: new Date(),
                costPrice: {
                    $cond: {
                        if: { $eq: [{ $type: "$costPrice" }, "missing"] },
                        then: newCostPrice,
                        else: {
                            $cond: {
                                // Check if denominator will be zero (e.g. -5 + 5 = 0)
                                if: { $eq: [{ $add: [{ $ifNull: ["$quantity", 0] }, quantityAdded] }, 0] },
                                then: newCostPrice, // Fallback to avoid crash
                                else: {
                                    $divide: [
                                        { $add: [ { $multiply: [{ $ifNull: ["$quantity", 0] }, { $ifNull: ["$costPrice", 0] }] }, { $multiply: [quantityAdded, newCostPrice] } ] },
                                        { $add: [{ $ifNull: ["$quantity", 0] }, quantityAdded] }
                                    ]
                                }
                            }
                        }
                    }
                },
                quantity: { $add: [{ $ifNull: ["$quantity", 0] }, quantityAdded] },
                createdAt: { $ifNull: ["$createdAt", new Date()] } 
            }
        }
    ];

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
            costAtTime: result.costPrice, 
            createdAt: new Date()
        });
    }
    
    return result;
}

export async function updateStock(productId, quantityChange, reason, linkedTransactionId, options = {}) {
    const validProdId = typeof productId === 'string' ? new ObjectId(productId) : productId;
    
    const filter = { _id: validProdId };
    
    const updatedProduct = await productsCollection().findOneAndUpdate(
        filter,
        { 
            $inc: { quantity: quantityChange },
            $set: { updatedAt: new Date() }
        },
        { returnDocument: 'after', ...options }
    );

    if (!updatedProduct) {
        throw new Error('Product not found for stock update.');
    }

    // [FIX] Added costAtTime to ensure historical profit accuracy
    await inventoryLogsCollection().insertOne({
        userId: updatedProduct.userId,
        productId: validProdId,
        quantityChange,
        reason,
        costAtTime: updatedProduct.costPrice || 0, // Critical for Blind Audit fix
        linkedTransactionId: typeof linkedTransactionId === 'string' ? new ObjectId(linkedTransactionId) : linkedTransactionId,
        createdAt: new Date()
    }, options);

    return updatedProduct;
}

export async function getAllProducts(userId) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    return await productsCollection().find({ userId: validUserId }).sort({ productName: 1 }).toArray();
}
