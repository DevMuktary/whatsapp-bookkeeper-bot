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
        // Optional: Check if a bank with the same name already exists for this user
        const existingBank = await banksCollection().findOne({ userId, bankName: { $regex: new RegExp(`^${bankName}$`, 'i') } });
        if (existingBank) {
            // In a more complex flow, we might ask if they want to update it.
            // For now, we'll prevent duplicates.
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
        // Re-throw the error to be handled by the taskHandler
        throw error;
    }
}
