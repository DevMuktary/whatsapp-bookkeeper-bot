import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const customersCollection = () => getDB().collection('customers');

/**
 * Finds a customer by name for a specific user, or creates one if they don't exist.
 * @param {ObjectId} userId The user's _id.
 * @param {string} customerName The name of the customer.
 * @returns {Promise<object>} The customer document.
 */
export async function findOrCreateCustomer(userId, customerName) {
    try {
        // Case-insensitive search
        const query = { userId, customerName: { $regex: new RegExp(`^${customerName}$`, 'i') } };
        let customer = await customersCollection().findOne(query);

        if (!customer) {
            logger.info(`Customer "${customerName}" not found for user ${userId}. Creating them.`);
            const newCustomer = {
                userId,
                customerName,
                contactInfo: null,
                balanceOwed: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            const result = await customersCollection().insertOne(newCustomer);
            customer = await customersCollection().findOne({ _id: result.insertedId });
        }
        return customer;
    } catch (error) {
        logger.error(`Error in findOrCreateCustomer for user ${userId}:`, error);
        throw new Error('Could not find or create customer.');
    }
}

/**
 * Updates a customer's outstanding balance.
 * @param {ObjectId} customerId The customer's _id.
 * @param {number} amountChange The amount to add (for credit sales) or subtract (for payments).
 * @returns {Promise<object>} The updated customer document.
 */
export async function updateBalanceOwed(customerId, amountChange) {
    try {
        const result = await customersCollection().findOneAndUpdate(
            { _id: customerId },
            { 
                $inc: { balanceOwed: amountChange },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after' }
        );
        logger.info(`Balance updated for customer ${customerId}. Change: ${amountChange}. New balance: ${result.balanceOwed}`);
        return result;
    } catch (error) {
        logger.error(`Error updating balance for customer ${customerId}:`, error);
        throw new Error('Could not update customer balance.');
    }
}
