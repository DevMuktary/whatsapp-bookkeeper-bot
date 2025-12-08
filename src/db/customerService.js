import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
import { escapeRegex } from '../utils/helpers.js'; // [FIX] Import Helper

const customersCollection = () => getDB().collection('customers');

export async function findOrCreateCustomer(userId, customerName, options = {}) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        
        // [FIX] Use escapeRegex to prevent crashes if name contains '(', '+', etc.
        const safeName = escapeRegex(customerName.trim());
        const query = { userId: validUserId, customerName: { $regex: new RegExp(`^${safeName}$`, 'i') } };
        
        let customer = await customersCollection().findOne(query, options);

        if (!customer) {
            logger.info(`Customer "${customerName}" not found for user ${validUserId}. Creating them.`);
            const newCustomer = {
                userId: validUserId,
                customerName: customerName.trim(), // Store original clean name
                contactInfo: null,
                balanceOwed: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            const result = await customersCollection().insertOne(newCustomer, options);
            customer = await customersCollection().findOne({ _id: result.insertedId }, options);
        }
        return customer;
    } catch (error) {
        logger.error(`Error in findOrCreateCustomer for user ${userId}:`, error);
        throw new Error('Could not find or create customer.');
    }
}

export async function updateBalanceOwed(customerId, amountChange, options = {}) {
    try {
        const validCustId = typeof customerId === 'string' ? new ObjectId(customerId) : customerId;
        const result = await customersCollection().findOneAndUpdate(
            { _id: validCustId },
            { 
                $inc: { balanceOwed: amountChange },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after', ...options }
        );
        logger.info(`Balance updated for customer ${validCustId}. Change: ${amountChange}.`);
        return result;
    } catch (error) {
        logger.error(`Error updating balance for customer ${customerId}:`, error);
        throw new Error('Could not update customer balance.');
    }
}

export async function findCustomerById(customerId, options = {}) {
    try {
        const validCustId = typeof customerId === 'string' ? new ObjectId(customerId) : customerId;
        return await customersCollection().findOne({ _id: validCustId }, options);
    } catch (error) {
        logger.error(`Error finding customer by ID ${customerId}:`, error);
        throw new Error('Could not find customer.');
    }
}

export async function getCustomersWithBalance(userId) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        const customers = await customersCollection().find({ 
            userId: validUserId, 
            balanceOwed: { $gt: 0 } 
        }).sort({ balanceOwed: -1 }).toArray();
        return customers;
    } catch (error) {
        logger.error(`Error getting customers with balance for user ${userId}:`, error);
        throw new Error('Could not retrieve customers with balances.');
    }
}
