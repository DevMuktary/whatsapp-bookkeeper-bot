import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is not set.");
}
const mongoClient = new MongoClient(mongoUri);

let db;

export async function connectToDB() {
    if (db) return { db };
    try {
        await mongoClient.connect();
        db = mongoClient.db("bookkeeperDB");
        console.log("✅ Successfully connected to MongoDB.");
        const usersCollection = db.collection('users');
        const transactionsCollection = db.collection('transactions');
        const productsCollection = db.collection('products');
        const inventoryLogsCollection = db.collection('inventory_logs');
        // --- ADD THIS LINE ---
        const conversationsCollection = db.collection('conversations');
        return { db, usersCollection, transactionsCollection, productsCollection, inventoryLogsCollection, conversationsCollection };
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB:", error);
        process.exit(1);
    }
}
