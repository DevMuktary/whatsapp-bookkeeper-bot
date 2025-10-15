import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const productsCollection = () => getDB().collection('products');
const inventoryLogsCollection = () => getDB().collection('inventory_logs');

/**
 * Finds a single product by name for a specific user.
 * @param {ObjectId} userId The user's _id.
 * @param {string} productName The name of the product.
 * @returns {Promise<object|null>} The product document or null if not found.
 */
export async function findProductByName(userId, productName) {
    try {
        const query = { userId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
        const product = await productsCollection().findOne(query);
        return product;
    } catch (error) {
        logger.error(`Error in findProductByName for user ${userId}:`, error);
        throw new Error('Could not find product by name.');
    }
}

/**
 * Finds a product by name for a specific user, or creates it if it doesn't exist.
 * New products are created with a default quantity of 0.
 * @param {ObjectId} userId The user's _id.
 * @param {string} productName The name of the product.
 * @returns {Promise<object>} The product document.
 */
export async function findOrCreateProduct(userId, productName) {
    try {
        const query = { userId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
        let product = await productsCollection().findOne(query);

        if (!product) {
            logger.info(`Product "${productName}" not found for user ${userId}. Creating it.`);
            const newProduct = {
                userId,
                productName,
                quantity: 0,
                costPrice: 0,
                sellingPrice: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            const result = await productsCollection().insertOne(newProduct);
            product = await productsCollection().findOne({ _id: result.insertedId });
        }
        return product;
    } catch (error) {
        logger.error(`Error in findOrCreateProduct for user ${userId}:`, error);
        throw new Error('Could not find or create product.');
    }
}

/**
 * Updates or inserts a product and logs the inventory change.
 * @param {ObjectId} userId The user's _id.
 * @param {string} productName The name of the product.
 * @param {number} quantityAdded The quantity of stock being added.
 * @param {number} costPrice The cost per unit.
 * @param {number} sellingPrice The selling price per unit.
 * @returns {Promise<object>} The upserted product document.
 */
export async function upsertProduct(userId, productName, quantityAdded, costPrice, sellingPrice) {
    try {
        const filter = { userId, productName: { $regex: new RegExp(`^${productName}$`, 'i') } };
        const update = {
            $set: {
                userId,
                productName,
                costPrice,
                sellingPrice,
                updatedAt: new Date(),
            },
            $inc: {
                quantity: quantityAdded,
            },
            $setOnInsert: {
                createdAt: new Date(),
            }
        };

        const result = await productsCollection().findOneAndUpdate(filter, update, {
            upsert: true,
            returnDocument: 'after'
        });

        const updatedProduct = result;
        logger.info(`Upserted product "${productName}" for user ${userId}.`);

        // Create an inventory log for the stock addition
        if (quantityAdded > 0) {
            const logEntry = {
                userId: updatedProduct.userId,
                productId: updatedProduct._id,
                quantityChange: quantityAdded,
                reason: 'STOCK_ADDITION',
                createdAt: new Date(),
            };
            await inventoryLogsCollection().insertOne(logEntry);
            logger.info(`Inventory log created for ${quantityAdded} units of "${productName}".`);
        }
        
        return updatedProduct;
    } catch (error) {
        logger.error(`Error in upsertProduct for user ${userId}:`, error);
        throw new Error('Could not upsert product.');
    }
}


/**
 * Updates the stock for a given product and creates an inventory log entry.
 * @param {ObjectId} productId The product's _id.
 * @param {number} quantityChange The amount to change the stock by (e.g., -2 for a sale).
 * @param {string} reason The reason for the change (e.g., 'SALE', 'INITIAL_STOCK').
 * @param {ObjectId} linkedTransactionId The transaction that triggered this stock change.
 * @returns {Promise<object>} The updated product document.
 */
export async function updateStock(productId, quantityChange, reason, linkedTransactionId) {
    try {
        const updatedProduct = await productsCollection().findOneAndUpdate(
            { _id: productId },
            { 
                $inc: { quantity: quantityChange },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after' }
        );

        if (!updatedProduct) {
            throw new Error(`Product with id ${productId} not found for stock update.`);
        }

        const logEntry = {
            userId: updatedProduct.userId,
            productId,
            quantityChange,
            reason,
            linkedTransactionId,
            createdAt: new Date(),
        };
        await inventoryLogsCollection().insertOne(logEntry);

        logger.info(`Stock updated for product ${productId}. Change: ${quantityChange}. New quantity: ${updatedProduct.quantity}`);
        return updatedProduct;
    } catch (error) {
        logger.error(`Error updating stock for product ${productId}:`, error);
        throw new Error('Could not update product stock.');
    }
}
