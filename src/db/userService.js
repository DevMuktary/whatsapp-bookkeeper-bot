import { ObjectId } from 'mongodb';
import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { USER_STATES } from '../utils/constants.js';

const usersCollection = () => getDB().collection('users');

/**
 * Finds a user by their WhatsApp ID or creates a new one if they don't exist.
 */
export async function findOrCreateUser(whatsappId) {
  try {
    let user = await usersCollection().findOne({ whatsappId });

    if (!user) {
      logger.info(`New user detected: ${whatsappId}. Creating new user record.`);
      const newUser = {
        whatsappId,
        businessName: null,
        email: null,
        isEmailVerified: false,
        currency: 'NGN', // Default to NGN to avoid null issues in reports
        state: USER_STATES.NEW_USER,
        stateContext: {},
        otp: null,
        otpExpires: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await usersCollection().insertOne(newUser);
      user = await usersCollection().findOne({ _id: result.insertedId });
    }
    return user;
  } catch (error) {
    logger.error(`Error in findOrCreateUser for ${whatsappId}:`, error);
    throw new Error('Could not find or create user.');
  }
}

/**
 * Finds a user by their MongoDB _id.
 * Critical for the Web Dashboard to get accurate profile data.
 */
export async function findUserById(userId) {
    try {
        const _id = new ObjectId(userId);
        return await usersCollection().findOne({ _id });
    } catch (error) {
        logger.error(`Error finding user by ID ${userId}:`, error);
        return null;
    }
}

/**
 * Updates a user's document.
 */
export async function updateUser(whatsappId, updateData) {
    try {
        const result = await usersCollection().findOneAndUpdate(
            { whatsappId },
            { $set: { ...updateData, updatedAt: new Date() } },
            { returnDocument: 'after' }
        );
        return result;
    } catch (error) {
        logger.error(`Error updating user ${whatsappId}:`, error);
        throw new Error('Could not update user.');
    }
}

export async function updateUserState(whatsappId, state, context = {}) {
    return updateUser(whatsappId, { state, stateContext: context });
}

