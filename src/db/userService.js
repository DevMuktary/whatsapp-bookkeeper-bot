import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { USER_STATES } from '../utils/constants.js';

const usersCollection = () => getDB().collection('users');

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
        // [NEW] Team Mode Fields
        role: 'OWNER',          // 'OWNER' or 'STAFF'
        linkedAccountId: null,  // If STAFF, this links to Owner's _id
        joinCode: null,         // Code for others to join
        
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

export async function getAllUsers() {
    try {
        return await usersCollection().find({ currency: { $ne: null } }).toArray();
    } catch (error) {
        logger.error('Error fetching all users:', error);
        return [];
    }
}

// [NEW] TEAM MODE FUNCTIONS

export async function createJoinCode(userId) {
    // Generate a random 6-character code
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await usersCollection().updateOne({ _id: userId }, { $set: { joinCode: code } });
    return code;
}

export async function findOwnerByJoinCode(code) {
    // Case insensitive search
    return await usersCollection().findOne({ joinCode: code, role: 'OWNER' });
}

export async function linkStaffToOwner(staffWhatsappId, ownerId) {
    // Reset staff account to defaults but link it to owner
    await usersCollection().updateOne(
        { whatsappId: staffWhatsappId },
        { 
            $set: { 
                role: 'STAFF', 
                linkedAccountId: ownerId,
                state: USER_STATES.IDLE,
                currency: null // Will inherit from owner
            } 
        }
    );
    return await usersCollection().findOne({ whatsappId: staffWhatsappId });
}
