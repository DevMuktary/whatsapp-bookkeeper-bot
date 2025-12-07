import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const productsCollection = () => getDB().collection('products');
const inventoryLogsCollection = () => getDB().collection('inventory_logs');

export async function findProductByName(userId, productName) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    // Exact match (case insensitive)
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    return await productsCollection().findOne(query);
}

// [NEW] Fuzzy Search for "Did you mean...?"
export async function findProductFuzzy(userId, searchText) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    // content match
    const query = { 
        userId: validUserId, 
        productName: { $regex: new RegExp(searchText, 'i') } 
    };
    return await productsCollection().find(query).limit(5).toArray();
}

export async function upsertProduct(userId, productName, quantityAdded, newCostPrice, sellingPrice, reorderLevel = 5) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
    
    const existingProduct = await productsCollection().findOne(query);
    
    let finalCostPrice = newCostPrice;

    // Atomic AVCO Calculation
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

    const update = [
        {
            $set: {
                userId: validUserId,
                productName: productName, 
                sellingPrice: sellingPrice,
                reorderLevel: reorderLevel,
                updatedAt: new Date(),
                costPrice: {
                    $cond: {
                        if: { $eq: [{ $type: "$costPrice" }, "missing"] },
                        then: newCostPrice,
                        else: {
                            $cond: {
                                if: { $eq: [quantityAdded, 0] },
                                then: newCostPrice, 
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

export async function updateStock(productId, quantityChange, reason, linkedTransactionId) {
    const validProdId = typeof productId === 'string' ? new ObjectId(productId) : productId;
    
    const filter = { _id: validProdId };
    
    // [FIX] REMOVED the Negative Stock Check ($gte). 
    // Now allows stock to go negative (e.g. -5) if they sell more than they have.
    
    const updatedProduct = await productsCollection().findOneAndUpdate(
        filter,
        { 
            $inc: { quantity: quantityChange },
            $set: { updatedAt: new Date() }
        },
        { returnDocument: 'after' }
    );

    if (!updatedProduct) {
        // Only error if product DOES NOT EXIST at all
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
