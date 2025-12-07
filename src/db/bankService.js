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
        // [FIX] Ensure userId is ObjectId
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;

        const existingBank = await banksCollection().findOne({ userId: validUserId, bankName: { $regex: new RegExp(`^${bankName}$`, 'i') } });
        if (existingBank) {
            throw new Error(`A bank account named "${bankName}" already exists.`);
        }

        const newBank = {
            userId: validUserId,
            bankName,
            balance: openingBalance,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await banksCollection().insertOne(newBank);
        logger.info(`Bank account "${bankName}" created for user ${validUserId} with ID: ${result.insertedId}`);
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
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        const banks = await banksCollection().find({ userId: validUserId }).toArray();
        return banks;
    } catch (error) {
        logger.error(`Error fetching bank accounts for user ${userId}:`, error);
        throw new Error('Could not retrieve bank accounts.');
    }
}

/**
 * Finds a single bank account by name for a specific user.
 * @param {ObjectId} userId The user's _id.
 * @param {string} bankName The name of the bank to find.
 * @returns {Promise<object|null>} The bank account document or null if not found.
 */
export async function findBankAccountByName(userId, bankName) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        const bank = await banksCollection().findOne({ userId: validUserId, bankName: { $regex: new RegExp(`^${bankName}$`, 'i') } });
        return bank;
    } catch (error) {
        logger.error(`Error finding bank account by name for user ${userId}:`, error);
        throw new Error('Could not retrieve bank account.');
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
        // [FIX] Ensure bankId is ObjectId
        const validBankId = typeof bankId === 'string' ? new ObjectId(bankId) : bankId;

        const result = await banksCollection().findOneAndUpdate(
            { _id: validBankId },
            { 
                $inc: { balance: amountChange },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after' }
        );
        logger.info(`Balance updated for bank ${validBankId}. Change: ${amountChange}. New balance: ${result.balance}`);
        return result;
    } catch (error) {
        logger.error(`Error updating balance for bank ${bankId}:`, error);
        throw new Error('Could not update bank balance.');
    }
}
