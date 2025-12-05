import { getDB } from './connection.js';
import logger from '../utils/logger.js';
import { USER_STATES } from '../utils/constants.js';
import { ObjectId } from 'mongodb';
import IORedis from 'ioredis';
import config from '../config/index.js';

const usersCollection = () => getDB().collection('users');

// --- REDIS SETUP ---
const redis = new IORedis(config.redis.url, config.redis.options);
const CACHE_TTL = 600; // Cache duration: 10 minutes

redis.on('error', (err) => {
    // Suppress connection errors here to avoid spamming logs, 
    // as the main app usually logs redis errors elsewhere.
});

// Helper to manage cache keys
const getKey = (type, id) => `user:${type}:${id.toString()}`;

export async function findOrCreateUser(whatsappId) {
  try {
    // 1. Check Cache
    const cacheKey = getKey('wa', whatsappId);
    const cachedUser = await redis.get(cacheKey);
    
    if (cachedUser) {
        return JSON.parse(cachedUser);
    }

    // 2. DB Lookup
    let user = await usersCollection().findOne({ whatsappId });

    if (!user) {
      logger.info(`New user detected: ${whatsappId}. Creating new user record.`);
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
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await usersCollection().insertOne(newUser);
      user = await usersCollection().findOne({ _id: result.insertedId });
    }

    // 3. Set Cache (Both WA ID and DB ID)
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

// [UPDATED] Find User by DB ID (Used by Queue Worker)
export async function findUserById(userId) {
    try {
        const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
        
        // 1. Check Cache
        const cacheKey = getKey('id', id);
        const cachedUser = await redis.get(cacheKey);

        if (cachedUser) {
            return JSON.parse(cachedUser);
        }

        // 2. DB Lookup
        const user = await usersCollection().findOne({ _id: id });

        // 3. Set Cache
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

export async function updateUser(whatsappId, updateData) {
    try {
        const result = await usersCollection().findOneAndUpdate(
            { whatsappId },
            { $set: { ...updateData, updatedAt: new Date() } },
            { returnDocument: 'after' }
        );

        // [UPDATED] Invalidate/Update Cache
        if (result) {
            const waKey = getKey('wa', whatsappId);
            const idKey = getKey('id', result._id);

            // Update with fresh data immediately (Write-Through Cache)
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
        // We generally don't cache "all users" as it's too large and changes frequently
        return await usersCollection().find({ currency: { $ne: null } }).toArray();
    } catch (error) {
        logger.error('Error fetching all users:', error);
        return [];
    }
}

export async function createJoinCode(userId) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await usersCollection().updateOne({ _id: userId }, { $set: { joinCode: code } });
    
    // Invalidate ID cache so next fetch sees the joinCode
    const idKey = getKey('id', userId);
    await redis.del(idKey);
    
    return code;
}

export async function findOwnerByJoinCode(code) {
    return await usersCollection().findOne({ joinCode: code, role: 'OWNER' });
}

export async function linkStaffToOwner(staffWhatsappId, ownerId) {
    const result = await usersCollection().findOneAndUpdate(
        { whatsappId: staffWhatsappId },
        { 
            $set: { 
                role: 'STAFF', 
                linkedAccountId: ownerId,
                state: USER_STATES.IDLE,
                currency: null 
            } 
        },
        { returnDocument: 'after' }
    );
    
    // Update Cache for Staff
    if (result) {
        const waKey = getKey('wa', staffWhatsappId);
        const idKey = getKey('id', result._id);
        const userStr = JSON.stringify(result);
        await redis.set(waKey, userStr, 'EX', CACHE_TTL);
        await redis.set(idKey, userStr, 'EX', CACHE_TTL);
    }

    return result;
}
