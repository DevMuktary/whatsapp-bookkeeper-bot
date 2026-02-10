import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
import { escapeRegex } from '../utils/helpers.js'; 

const customersCollection = () => getDB().collection('customers');

export async function findOrCreateCustomer(userId, customerName, options = {}) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        
        // [FIX] CRASH PROTECTION: If name is missing/null, default to "Walk-in Customer"
        // This prevents the .trim() error from stopping the bot.
        let safeName = "Walk-in Customer";
        if (customerName && typeof customerName === 'string' && customerName.trim().length > 0) {
            safeName = customerName.trim();
        }

        // Use escapeRegex to handle names with special characters like "Muktary & Co"
        const cleanRegex = escapeRegex(safeName);
        const query = { userId: validUserId, customerName: { $regex: new RegExp(`^${cleanRegex}$`, 'i') } };
        
        let customer = await customersCollection().findOne(query, options);

        if (!customer) {
            logger.info(`Customer "${safeName}" not found. Creating new record.`);
            const newCustomer = {
                userId: validUserId,
                customerName: safeName, 
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
        logger.error(`Error in findOrCreateCustomer:`, error);
        // Fallback: Return a temporary object so the transaction doesn't fail completely
        return { _id: new ObjectId(), customerName: 'Unknown Customer', userId, balanceOwed: 0 };
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
        return result;
    } catch (error) {
        logger.error(`Error updating balance:`, error);
        throw new Error('Could not update customer balance.');
    }
}

export async function findCustomerById(customerId, options = {}) {
    try {
        const validCustId = typeof customerId === 'string' ? new ObjectId(customerId) : customerId;
        return await customersCollection().findOne({ _id: validCustId }, options);
    } catch (error) {
        throw new Error('Could not find customer.');
    }
}

export async function getCustomersWithBalance(userId) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        return await customersCollection().find({ 
            userId: validUserId, 
            balanceOwed: { $gt: 0 } 
        }).sort({ balanceOwed: -1 }).toArray();
    } catch (error) {
        throw new Error('Could not retrieve customers with balances.');
    }
}
