import { connectToDB } from './src/db.js';
import { startBot } from './src/bot.js';
import { startApi } from './src/api.js';

// Railway provides the PORT environment variable
const PORT = process.env.PORT || 3000;

/**
 * Main application entry point.
 */
async function main() {
    try {
        // 1. Connect to the database
        console.log("Connecting to database...");
        const collections = await connectToDB();

        // 2. Start the API Server
        console.log("Starting API server...");
        const app = startApi(collections);
        app.listen(PORT, () => {
            console.log(`✅ API Server running on port ${PORT}`);
        });

        // 3. Start the WhatsApp Bot
        // We pass the collections, so it doesn't have to connect.
        await startBot(collections);

    } catch (error) {
        console.error("Fatal error during startup:", error);
        process.exit(1);
    }
}

// Run the application
main();
