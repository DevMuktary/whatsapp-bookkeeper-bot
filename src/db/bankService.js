import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { ObjectId } from 'mongodb';
import { escapeRegex } from '../utils/helpers.js'; // [FIX] Import Helper

const banksCollection = () => getDB().collection('banks');

export async function createBankAccount(userId, bankName, openingBalance) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        
        // [FIX] Escape Regex
        const safeName = escapeRegex(bankName.trim());
        const existingBank = await banksCollection().findOne({ userId: validUserId, bankName: { $regex: new RegExp(`^${safeName}$`, 'i') } });
        
        if (existingBank) {
            throw new Error(`A bank account named "${bankName}" already exists.`);
        }

        const newBank = {
            userId: validUserId,
            bankName: bankName.trim(),
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

export async function findBankAccountByName(userId, bankName) {
    try {
        const validUserId = typeof userId === 'string' ? new ObjectId(userId) : userId;
        
        // [FIX] Escape Regex
        const safeName = escapeRegex(bankName.trim());
        const bank = await banksCollection().findOne({ userId: validUserId, bankName: { $regex: new RegExp(`^${safeName}$`, 'i') } });
        return bank;
    } catch (error) {
        logger.error(`Error finding bank account by name for user ${userId}:`, error);
        throw new Error('Could not retrieve bank account.');
    }
}

export async function updateBankBalance(bankId, amountChange, options = {}) {
    try {
        const validBankId = typeof bankId === 'string' ? new ObjectId(bankId) : bankId;
        const result = await banksCollection().findOneAndUpdate(
            { _id: validBankId },
            { 
                $inc: { balance: amountChange },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after', ...options }
        );
        logger.info(`Balance updated for bank ${validBankId}. Change: ${amountChange}. New balance: ${result.balance}`);
        return result;
    } catch (error) {
        logger.error(`Error updating balance for bank ${bankId}:`, error);
        throw new Error('Could not update bank balance.');
    }
}
