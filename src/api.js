import express from 'express';
import cors from 'cors';
import { loginUser } from './services/authService.js';
// --- NEW: Import both middlewares ---
import { authenticateToken, adminOnly } from './middleware/authMiddleware.js';
import { 
    getUserSummary, 
    getUserTransactions, 
    getUserInventory 
} from './services/userService.js';
// --- NEW: Import the admin API function ---
import { getAllUsers } from './services/adminService.js';


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
    
    // --- Protected User Routes (User Must Be Logged In) ---
    app.get('/api/v1/user/summary', authenticateToken, (req, res) => {
        getUserSummary(req, res, collections);
    });

    app.get('/api/v1/user/transactions', authenticateToken, (req, res) => {
        getUserTransactions(req, res, collections);
    });

    app.get('/api/v1/user/inventory', authenticateToken, (req, res) => {
        getUserInventory(req, res, collections);
    });
    
    
    // --- NEW: Protected Admin Routes (Must Be Admin) ---
    // This route uses a *chain* of middleware.
    // 1. 'authenticateToken' runs (checks if logged in).
    // 2. 'adminOnly' runs (checks if role is 'admin').
    // 3. 'getAllUsers' runs (only if both checks pass).
    app.get('/api/v1/admin/users', authenticateToken, adminOnly, (req, res) => {
       getAllUsers(req, res, collections);
    });

    return app;
}
