import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is not set.");
}
const mongoClient = new MongoClient(mongoUri);

let db;
let collections = {};

export async function connectToDB() {
    if (db) {
        return collections;
    }
    try {
        await mongoClient.connect();
        db = mongoClient.db("bookkeeperDB");
        
        // Define collections once after connection is established
        collections = {
            db,
            usersCollection: db.collection('users'),
            transactionsCollection: db.collection('transactions'),
            productsCollection: db.collection('products'),
            inventoryLogsCollection: db.collection('inventory_logs'),
            conversationsCollection: db.collection('conversations'),
        };

        console.log("✅ Successfully connected to MongoDB.");
        return collections;
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB:", error);
        process.exit(1);
    }
}
