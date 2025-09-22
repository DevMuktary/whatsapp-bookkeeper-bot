import express from 'express';
import cors from 'cors';
import { loginUser } from './services/authService.js';
import { authenticateToken } from './middleware/authMiddleware.js'; // <-- NEW: Import middleware
import { getUserSummary } from './services/userService.js';    // <-- NEW: Import user service

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

    // --- Unprotected Routes (Public) ---
    app.get('/api/v1/health', (req, res) => {
        res.status(200).json({ status: 'ok', message: 'Fynax API is running' });
    });

    app.post('/api/v1/auth/login', (req, res) => {
        loginUser(req, res, collections);
    });
    
    // --- Protected Routes (User Must Be Logged In) ---
    // Notice 'authenticateToken' is "plugged in" before the main function.
    // It runs first, checks the token, and then calls the next function (getUserSummary).
    app.get('/api/v1/user/summary', authenticateToken, (req, res) => {
        getUserSummary(req, res, collections);
    });
    
    
    // --- (Placeholder) Admin get all users route ---
    // We will also protect this with middleware
    // app.get('/api/v1/admin/users', authenticateToken, (req, res) => {
    //    // Logic for admins to get all users
    // });

    return app;
}
