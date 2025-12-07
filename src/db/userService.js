import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { USER_STATES } from '../utils/constants.js';
import { ObjectId } from 'mongodb';
import redis from './redisClient.js'; // [FIX] Use Singleton

const usersCollection = () => getDB().collection('users');
const CACHE_TTL = 600; 

const getKey = (type, id) => `user:${type}:${id.toString()}`;

export function checkSubscriptionAccess(user) {
    const now = new Date();
    const getValidDate = (dateVal) => dateVal ? new Date(dateVal) : null;

    const trialEnd = getValidDate(user.trialEndsAt);
    const subEnd = getValidDate(user.subscriptionExpiresAt);

    // 1. Check Trial
    if (trialEnd && trialEnd > now) {
        const diffTime = trialEnd.getTime() - now.getTime();
        const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return { allowed: true, type: 'TRIAL', daysLeft: daysLeft };
    }

    // 2. Check Active Subscription
    if (subEnd && subEnd > now) {
        const diffTime = subEnd.getTime() - now.getTime();
        const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return { allowed: true, type: 'ACTIVE', daysLeft: daysLeft };
    }

    return { allowed: false, type: 'EXPIRED' };
}

export async function findOrCreateUser(whatsappId) {
  try {
    const cacheKey = getKey('wa', whatsappId);
    const cachedUser = await redis.get(cacheKey);
    if (cachedUser) return JSON.parse(cachedUser);

    let user = await usersCollection().findOne({ whatsappId });

    if (!user) {
      logger.info(`New user detected: ${whatsappId}. Creating new user record.`);
      
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + 7);

      const newUser = {
        whatsappId,
        businessName: null,
        email: null,
        isEmailVerified: false,
        currency: null,
        role: 'OWNER',
        linkedAccountId: null,
        joinCode: null,
        state: USER_STATES.NEW_USER, 
        stateContext: {},
        otp: null,
        otpExpires: null,
        subscriptionStatus: 'TRIAL',
        trialEndsAt: trialEnd,
        subscriptionExpiresAt: null,
        paystackCustomerCode: null,
        dedicatedAccount: null, 
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await usersCollection().insertOne(newUser);
      user = await usersCollection().findOne({ _id: result.insertedId });
    }

    if (user) {
        await redis.set(cacheKey, JSON.stringify(user), 'EX', CACHE_TTL);
        await redis.set(getKey('id', user._id), JSON.stringify(user), 'EX', CACHE_TTL);
    }

    return user;
  } catch (error) {
    logger.error(`Error in findOrCreateUser for ${whatsappId}:`, error);
    throw new Error('Could not find or create user.');
  }
}

export async function findUserById(userId) {
    try {
        // [FIX] Safe ID Casting
        const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
        
        const cacheKey = getKey('id', id);
        const cachedUser = await redis.get(cacheKey);
        if (cachedUser) return JSON.parse(cachedUser);

        const user = await usersCollection().findOne({ _id: id });
        if (user) {
            await redis.set(cacheKey, JSON.stringify(user), 'EX', CACHE_TTL);
            await redis.set(getKey('wa', user.whatsappId), JSON.stringify(user), 'EX', CACHE_TTL);
        }
        return user;
    } catch (error) {
        logger.error(`Error finding user by ID ${userId}:`, error);
        return null;
    }
}

export async function findUserByPhone(phone) {
    const cleanPhone = phone.replace('+', '').trim();
    return await usersCollection().findOne({ whatsappId: cleanPhone });
}

export async function getSystemStats() {
    try {
        const totalUsers = await usersCollection().countDocuments({});
        const activeSubs = await usersCollection().countDocuments({ subscriptionStatus: 'ACTIVE' });
        const trials = await usersCollection().countDocuments({ subscriptionStatus: 'TRIAL' });
        const estimatedRevenue = activeSubs * 7500; 
        return { totalUsers, activeSubs, trials, estimatedRevenue };
    } catch (error) {
        logger.error('Error fetching system stats:', error);
        return { totalUsers: 0, activeSubs: 0, trials: 0, estimatedRevenue: 0 };
    }
}

export async function updateUser(whatsappId, updateData) {
    try {
        const result = await usersCollection().findOneAndUpdate(
            { whatsappId },
            { $set: { ...updateData, updatedAt: new Date() } },
            { returnDocument: 'after' }
        );

        if (result) {
            const waKey = getKey('wa', whatsappId);
            const idKey = getKey('id', result._id);
            const userStr = JSON.stringify(result);
            await redis.set(waKey, userStr, 'EX', CACHE_TTL);
            await redis.set(idKey, userStr, 'EX', CACHE_TTL);
        }

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

export async function createJoinCode(userId) {
    const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    await usersCollection().updateOne({ _id: id }, { $set: { joinCode: code } });
    
    // Clear cache to force refresh
    const idKey = getKey('id', id);
    await redis.del(idKey);
    
    return code;
}

export async function findOwnerByJoinCode(code) {
    return await usersCollection().findOne({ joinCode: code, role: 'OWNER' });
}

export async function linkStaffToOwner(staffWhatsappId, ownerId) {
    const validOwnerId = typeof ownerId === 'string' ? new ObjectId(ownerId) : ownerId;

    const result = await usersCollection().findOneAndUpdate(
        { whatsappId: staffWhatsappId },
        { 
            $set: { 
                role: 'STAFF', 
                linkedAccountId: validOwnerId,
                state: USER_STATES.IDLE,
                currency: null 
            } 
        },
        { returnDocument: 'after' }
    );
    if (result) {
        const waKey = getKey('wa', staffWhatsappId);
        const idKey = getKey('id', result._id);
        const userStr = JSON.stringify(result);
        await redis.set(waKey, userStr, 'EX', CACHE_TTL);
        await redis.set(idKey, userStr, 'EX', CACHE_TTL);
    }
    return result;
}
