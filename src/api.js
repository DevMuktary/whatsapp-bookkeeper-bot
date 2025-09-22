import express from 'express';
import cors from 'cors';
import { loginUser } from './services/authService.js';
import { authenticateToken, adminOnly } from './middleware/authMiddleware.js';
import { 
    getUserSummary, 
    getUserTransactions, 
    getUserInventory 
} from './services/userService.js';
// --- NEW: Import the new admin API functions ---
import { 
    getAllUsers, 
    getReportForUser 
} from './services/adminService.js';


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
    
    
    // --- Protected Admin Routes (Must Be Admin) ---
    app.get('/api/v1/admin/users', authenticateToken, adminOnly, (req, res) => {
       getAllUsers(req, res, collections);
    });

    // --- NEW: Admin Report Download Route ---
    // This uses URL parameters (e.g., .../pnl)
    app.get('/api/v1/admin/reports/user/:userId/:reportType', authenticateToken, adminOnly, (req, res) => {
       getReportForUser(req, res, collections);
    });

    return app;
}
