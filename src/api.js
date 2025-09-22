import express from 'express';
import cors from 'cors';
import { loginUser } from './services/authService.js'; // <-- NEW IMPORT

// --- Security: Define which websites can access your API ---
const corsOptions = {
    origin: ['http://localhost:3000', 'https://fynaxtech.com', 'https://www.fynaxtech.com'],
    optionsSuccessStatus: 200
};

/**
 * Initializes and configures the Express API server.
 * @param {object} collections - The MongoDB collections object.
 * @returns {object} The configured Express app.
 */
export function startApi(collections) {
    const app = express();

    // --- Middlewares ---
    app.use(cors(corsOptions));
    app.use(express.json());

    // --- API Routes ---

    // A simple test route
    app.get('/api/v1/health', (req, res) => {
        res.status(200).json({ status: 'ok', message: 'Fynax API is running' });
    });

    // --- NEW: The real login route ---
    // We pass (req, res) to the function, and also the 'collections'
    app.post('/api/v1/auth/login', (req, res) => {
        loginUser(req, res, collections);
    });
    
    // (Placeholder) Get user data route
    // app.get('/api/v1/user/summary', (req, res) => {
    //     // Logic to get user's financial summary
    // });
    
    // (Placeholder) Admin get all users route
    // app.get('/api/v1/admin/users', (req, res) => {
    //    // Logic for admins to get all users
    // });

    return app;
}
