import express from 'express';
import cors from 'cors';
import { loginUser } from './services/authService.js';
import { authenticateToken, adminOnly } from './middleware/authMiddleware.js';
import { 
    getUserSummary, 
    getUserTransactions, 
    getUserInventory,
    getUserReport
} from './services/userService.js';
import { 
    getAllUsers, 
    getReportForUser,
    generateAllPnlReportsZip,
    blockUserApi, // <-- NEW IMPORT
    unblockUserApi // <-- NEW IMPORT
} from './services/adminService.js';

// --- Security: Define which websites can access your API ---
const corsOptions = {
    origin: ['http://localhost:3000', 'https://fynaxtech.com', 'https://www.fynaxtech.com'],
    optionsSuccessStatus: 200
};

/**
 * Initializes and configures the Express API server.
 */
export function startApi(collections) {
    const app = express();
    app.use(cors(corsOptions));
    app.use(express.json());

    // --- Unprotected Routes (Public) ---
    app.get('/api/v1/health', (req, res) => {
        res.status(200).json({ status: 'ok', message: 'Fynax API is running' });
    });
    app.post('/api/v1/auth/login', (req, res) => {
        loginUser(req, res, collections);
    });
    
    // --- Protected User Routes ---
    app.get('/api/v1/user/summary', authenticateToken, (req, res) => {
        getUserSummary(req, res, collections);
    });
    app.get('/api/v1/user/transactions', authenticateToken, (req, res) => {
        getUserTransactions(req, res, collections);
    });
    app.get('/api/v1/user/inventory', authenticateToken, (req, res) => {
        getUserInventory(req, res, collections);
    });
    app.get('/api/v1/user/reports/:reportType', authenticateToken, (req, res) => {
        getUserReport(req, res, collections);
    });
    
    // --- Protected Admin Routes ---
    app.get('/api/v1/admin/users', authenticateToken, adminOnly, (req, res) => {
       getAllUsers(req, res, collections);
    });
    app.get('/api/v1/admin/reports/user/:userId/:reportType', authenticateToken, adminOnly, (req, res) => {
       getReportForUser(req, res, collections);
    });
    app.get('/api/v1/admin/reports/all-pnl-zip', authenticateToken, adminOnly, (req, res) => {
        generateAllPnlReportsZip(req, res, collections);
    });

    // --- NEW: Admin User Management Routes ---
    app.post('/api/v1/admin/users/block', authenticateToken, adminOnly, (req, res) => {
        blockUserApi(req, res, collections);
    });
    app.post('/api/v1/admin/users/unblock', authenticateToken, adminOnly, (req, res) => {
        unblockUserApi(req, res, collections);
    });

    return app;
}
