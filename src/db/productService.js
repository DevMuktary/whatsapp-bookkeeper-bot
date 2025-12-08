import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
import { escapeRegex } from '../utils/helpers.js';

const productsCollection = () => getDB().collection('products');
const inventoryLogsCollection = () => getDB().collection('inventory_logs');

export async function findProductByName(userId, productName, options = {}) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const safeName = escapeRegex(productName.trim());
    const query = { userId: validUserId, productName: { $regex: new RegExp(`^${safeName}$`, 'i') } };
    return await productsCollection().findOne(query, options);
}

export async function findProductById(productId, options = {}) {
    try {
        const validProdId = typeof productId === 'string' ? new ObjectId(productId) : productId;
        return await productsCollection().findOne({ _id: validProdId }, options);
    } catch (error) {
        logger.error(`Error finding product by ID ${productId}:`, error);
        throw new Error('Could not find product.');
    }
}

export async function findProductFuzzy(userId, searchText) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
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
    
    const update = [
        {
            $set: {
                userId: validUserId,
                productName: productName.trim(),
                sellingPrice: sellingPrice,
                reorderLevel: reorderLevel,
                updatedAt: new Date(),
                costPrice: {
                    $cond: {
                        if: { $eq: [{ $type: "$costPrice" }, "missing"] },
                        then: newCostPrice,
                        else: {
                            $cond: {
                                if: { $eq: [{ $add: [{ $ifNull: ["$quantity", 0] }, quantityAdded] }, 0] },
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

    await inventoryLogsCollection().insertOne({
        userId: updatedProduct.userId,
        productId: validProdId,
        quantityChange,
        reason,
        costAtTime: updatedProduct.costPrice || 0,
        linkedTransactionId: typeof linkedTransactionId === 'string' ? new ObjectId(linkedTransactionId) : linkedTransactionId,
        createdAt: new Date()
    }, options);

    return updatedProduct;
}

export async function getAllProducts(userId) {
    const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    return await productsCollection().find({ userId: validUserId }).sort({ productName: 1 }).toArray();
}
