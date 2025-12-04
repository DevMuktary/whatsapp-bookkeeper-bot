import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { USER_STATES } from '../utils/constants.js';

const usersCollection = () => getDB().collection('users');

/**
 * Finds a user by their WhatsApp ID or creates a new one if they don't exist.
 * New users are started in the NEW_USER state to trigger the welcome sequence.
 * @param {string} whatsappId The user's WhatsApp ID (phone number).
 * @returns {Promise<object>} The user document.
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
        currency: null,
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
 * Updates a user's document.
 * @param {string} whatsappId The user's WhatsApp ID.
 * @param {object} updateData The fields to update.
 * @returns {Promise<object>} The updated user document.
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

/**
 * A specific helper to update a user's state and context.
 * @param {string} whatsappId The user's WhatsApp ID.
 * @param {string} state The new state from USER_STATES.
 * @param {object} context Optional context to store for the state.
 * @returns {Promise<object>} The updated user document.
 */
export async function updateUserState(whatsappId, state, context = {}) {
    return updateUser(whatsappId, { state, stateContext: context });
}

// [NEW] Helper for Scheduler
export async function getAllUsers() {
    try {
        // Only fetch users who have at least set a currency (active users)
        return await usersCollection().find({ currency: { $ne: null } }).toArray();
    } catch (error) {
        logger.error('Error fetching all users:', error);
        return [];
    }
}
