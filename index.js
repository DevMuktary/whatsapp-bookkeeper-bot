import { connectToDB } from './src/db.js';
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
        // The API server now handles everything, including WhatsApp webhooks.
        console.log("Starting API server...");
        const app = startApi(collections);
        app.listen(PORT, () => {
            console.log(`✅ API Server is live and listening on port ${PORT}`);
        });

    } catch (error) {
        console.error("❌ Fatal error during startup:", error);
        process.exit(1);
    }
}

// Run the application
main();
