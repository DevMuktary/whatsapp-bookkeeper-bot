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
    blockUserApi,
    unblockUserApi
} from './services/adminService.js';
import { handleWebhook } from './messageHandler.js';


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
    app.use(express.json()); 
    app.use(cors(corsOptions));

    // --- API Routes ---

    // --- Unprotected Routes (Public) ---
    app.get('/api/v1/health', (req, res) => {
        res.status(200).json({ status: 'ok', message: 'Fynax API is running' });
    });
    app.post('/api/v1/auth/login', (req, res) => {
        loginUser(req, res, collections);
    });
    
    // --- WHATSAPP WEBHOOK ROUTES ---
    app.get('/api/v1/webhooks/whatsapp', (req, res) => {
        const verify_token = process.env.WHATSAPP_VERIFY_TOKEN;
        let mode = req.query['hub.mode'];
        let token = req.query['hub.verify_token'];
        let challenge = req.query['hub.challenge'];

        if (mode && token) {
            if (mode === 'subscribe' && token === verify_token) {
                console.log('✅ Webhook verified');
                res.status(200).send(challenge);
            } else {
                console.error('❌ Webhook verification failed: Tokens do not match.');
                res.sendStatus(403);
            }
        } else {
            res.sendStatus(400);
        }
    });

    app.post('/api/v1/webhooks/whatsapp', (req, res) => {
        handleWebhook(req.body, collections);
        res.sendStatus(200);
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

    app.get('/api/v1/user/reports/:reportType', authenticateToken, (req, res) => {
        getUserReport(req, res, collections);
    });
    
    
    // --- Protected Admin Routes (Must Be Admin) ---
    app.get('/api/v1/admin/users', authenticateToken, adminOnly, (req, res) => {
       getAllUsers(req, res, collections);
    });

    app.get('/api/v1/admin/reports/user/:userId/:reportType', authenticateToken, adminOnly, (req, res) => {
       getReportForUser(req, res, collections);
    });

    app.get('/api/v1/admin/reports/all-pnl-zip', authenticateToken, adminOnly, (req, res) => {
        generateAllPnlReportsZip(req, res, collections);
    });

    app.post('/api/v1/admin/users/block', authenticateToken, adminOnly, (req, res) => {
        blockUserApi(req, res, collections);
    });
    app.post('/api/v1/admin/users/unblock', authenticateToken, adminOnly, (req, res) => {
        unblockUserApi(req, res, collections);
    });

    return app;
}
