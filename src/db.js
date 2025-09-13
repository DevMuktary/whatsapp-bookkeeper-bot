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
        // --- ADD THIS LINE ---
        const productsCollection = db.collection('products');
        return { db, usersCollection, transactionsCollection, productsCollection };
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB:", error);
        process.exit(1);
    }
}
