import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const customersCollection = () => getDB().collection('customers');

export async function findOrCreateCustomer(userId, customerName) {
    try {
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

/**
 * Finds a single customer by their MongoDB _id.
 * @param {ObjectId} customerId The _id of the customer.
 * @returns {Promise<object|null>} The customer document or null if not found.
 */
export async function findCustomerById(customerId) {
    try {
        const customer = await customersCollection().findOne({ _id: customerId });
        return customer;
    } catch (error) {
        logger.error(`Error finding customer by ID ${customerId}:`, error);
        throw new Error('Could not find customer.');
    }
}
