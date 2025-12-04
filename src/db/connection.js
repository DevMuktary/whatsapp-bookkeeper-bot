import { MongoClient } from 'mongodb';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const client = new MongoClient(config.mongoURI);
let db;

export async function connectToDB() {
  if (db) {
    return db;
  }
  try {
    logger.info('Connecting to MongoDB...');
    await client.connect();
    db = client.db();
    logger.info('MongoDB connection established.');

    // [OPTIMIZATION] Ensure Indexes for Scale
    // This runs once on startup and makes your queries lightning fast.
    try {
        await db.collection('transactions').createIndex({ userId: 1, date: -1 });
        await db.collection('transactions').createIndex({ userId: 1, type: 1 });
        await db.collection('products').createIndex({ userId: 1, productName: 1 });
        await db.collection('customers').createIndex({ userId: 1, customerName: 1 });
        await db.collection('users').createIndex({ whatsappId: 1 }, { unique: true });
        logger.info('Database indexes verified.');
    } catch (idxError) {
        logger.warn('Index creation warning (safe to ignore):', idxError.message);
    }

    return db;
  } catch (error) {
    logger.error('Could not connect to MongoDB', error);
    throw error;
  }
}

// Export a function to get the database instance
export const getDB = () => {
  if (!db) {
    throw new Error('Database not initialized! Call connectToDB first.');
  }
  return db;
};
