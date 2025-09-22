import express from 'express';
import cors from 'cors';

// --- Security: Define which websites can access your API ---
const corsOptions = {
    origin: ['http://localhost:3000', 'https://fynaxtech.com', 'https://www.fynaxtech.com'],
    optionsSuccessStatus: 200 // For legacy browser support
};

/**
 * Initializes and configures the Express API server.
 * @param {object} collections - The MongoDB collections object.
 * @returns {object} The configured Express app.
 */
export function startApi(collections) {
    const app = express();

    // --- Middlewares ---
    app.use(cors(corsOptions)); // Apply CORS security
    app.use(express.json());   // Parse incoming JSON payloads

    // --- API Routes ---

    // A simple test route
    app.get('/api/v1/health', (req, res) => {
        res.status(200).json({ status: 'ok', message: 'Fynax API is running' });
    });

    // (Placeholder) User login route
    // app.post('/api/v1/auth/login', async (req, res) => {
    //     // Logic to log in the user will go here
    // });

    // (Placeholder) Get user data route
    // app.get('/api/v1/user/summary', (req, res) => {
    //     // Logic to get user's financial summary
    // });
    
    // (Placeholder) Admin get all users route
    // app.get('/api/v1/admin/users', (req, res) => {
    //    // Logic for admins to get all users
    // });


    // --- Return the app ---
    // We don't call app.listen() here.
    // index.js will do that.
    return app;
}
