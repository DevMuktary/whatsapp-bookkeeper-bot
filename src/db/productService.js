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

// [FIX] Atomic Upsert to prevent Race Conditions
export async function upsertProduct(userId, productName, quantityAdded, newCostPrice, sellingPrice, reorderLevel = 5) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    
    // We use a pipeline update to access existing document fields for AVCO calculation atomically
    const update = [
        {
            $set: {
                userId: validUserId,
                productName: productName, // Update name casing
                sellingPrice: sellingPrice,
                reorderLevel: reorderLevel,
                updatedAt: new Date(),
                // Atomic AVCO Calculation:
                // If product exists: ((qty * cost) + (addQty * addCost)) / (qty + addQty)
                // If new: addCost
                costPrice: {
                    $cond: {
                        if: { $eq: [{ $type: "$costPrice" }, "missing"] }, // Is new doc?
                        then: newCostPrice,
                        else: {
                            $cond: {
                                if: { $eq: [quantityAdded, 0] },
                                then: newCostPrice, // If no stock added, just update cost manually
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
                createdAt: { $ifNull: ["$createdAt", new Date()] } // Only set if missing
            }
        }
    ];

    const result = await productsCollection().findOneAndUpdate(
        query, 
        update, 
        { upsert: true, returnDocument: 'after' }
    );
    
    // Log the movement
    if (quantityAdded !== 0) {
        await inventoryLogsCollection().insertOne({
            userId: validUserId,
            productId: result._id,
            quantityChange: quantityAdded,
            reason: 'STOCK_ADJUSTMENT',
            costAtTime: result.costPrice, // The atomic result
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
