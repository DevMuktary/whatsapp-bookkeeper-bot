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

export async function findCustomerById(customerId) {
    try {
        const customer = await customersCollection().findOne({ _id: customerId });
        return customer;
    } catch (error) {
        logger.error(`Error finding customer by ID ${customerId}:`, error);
        throw new Error('Could not find customer.');
    }
}

/**
 * Fetches all customers who have an outstanding balance.
 * @param {ObjectId} userId The user's _id.
 * @returns {Promise<Array<object>>} An array of customer documents with balanceOwed > 0.
 */
export async function getCustomersWithBalance(userId) {
    try {
        const customers = await customersCollection().find({ 
            userId, 
            balanceOwed: { $gt: 0 } 
        }).sort({ balanceOwed: -1 }).toArray();
        return customers;
    } catch (error) {
        logger.error(`Error getting customers with balance for user ${userId}:`, error);
        throw new Error('Could not retrieve customers with balances.');
    }
}
