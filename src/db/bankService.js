import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';

const banksCollection = () => getDB().collection('banks');

/**
 * Creates a new bank account for a user.
 * @param {ObjectId} userId The user's _id.
 * @param {string} bankName The name of the bank account.
 * @param {number} openingBalance The initial balance of the account.
 * @returns {Promise<object>} The newly created bank account document.
 */
export async function createBankAccount(userId, bankName, openingBalance) {
    try {
        const existingBank = await banksCollection().findOne({ userId, bankName: { $regex: new RegExp(`^${bankName}$`, 'i') } });
        if (existingBank) {
            throw new Error(`A bank account named "${bankName}" already exists.`);
        }

        const newBank = {
            userId,
            bankName,
            balance: openingBalance,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await banksCollection().insertOne(newBank);
        logger.info(`Bank account "${bankName}" created for user ${userId} with ID: ${result.insertedId}`);
        return await banksCollection().findOne({ _id: result.insertedId });
    } catch (error) {
        logger.error(`Error creating bank account for user ${userId}:`, error);
        throw error;
    }
}

/**
 * Fetches all bank accounts for a specific user.
 * @param {ObjectId} userId The user's _id.
 * @returns {Promise<Array<object>>} An array of bank account documents.
 */
export async function getAllBankAccounts(userId) {
    try {
        const banks = await banksCollection().find({ userId }).toArray();
        return banks;
    } catch (error) {
        logger.error(`Error fetching bank accounts for user ${userId}:`, error);
        throw new Error('Could not retrieve bank accounts.');
    }
}

/**
 * Updates the balance of a specific bank account.
 * @param {ObjectId} bankId The _id of the bank account.
 * @param {number} amountChange The amount to add (positive for income) or subtract (negative for expense).
 * @returns {Promise<object>} The updated bank account document.
 */
export async function updateBankBalance(bankId, amountChange) {
    try {
        const result = await banksCollection().findOneAndUpdate(
            { _id: bankId },
            { 
                $inc: { balance: amountChange },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after' }
        );
        logger.info(`Balance updated for bank ${bankId}. Change: ${amountChange}. New balance: ${result.balance}`);
        return result;
    } catch (error) {
        logger.error(`Error updating balance for bank ${bankId}:`, error);
        throw new Error('Could not update bank balance.');
    }
}
