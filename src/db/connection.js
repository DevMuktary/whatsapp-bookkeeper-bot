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
    db = client.db(); // You can specify a DB name here, e.g., client.db("fynax")
    logger.info('MongoDB connection established.');
    return db;
  } catch (error) {
    logger.error('Could not connect to MongoDB', error);
    // Propagate the error to be handled by the startup script in index.js
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
