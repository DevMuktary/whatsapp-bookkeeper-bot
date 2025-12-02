import express from 'express';
import { initiateWebLogin, verifyWebLogin, authenticateWebUser } from '../services/webAuthService.js';
import { getDashboardStats, generateWebReport } from '../services/dashboardService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// --- AUTHENTICATION ---

router.post('/auth/login', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: "Phone number is required" });
        
        const result = await initiateWebLogin(phone);
        res.json(result);
    } catch (error) {
        logger.error('Web login init error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/auth/verify', async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) return res.status(400).json({ error: "Phone and OTP are required" });

        const result = await verifyWebLogin(phone, otp);
        res.json(result);
    } catch (error) {
        logger.error('Web login verify error:', error);
        res.status(401).json({ error: error.message });
    }
});

// --- DASHBOARD DATA (Protected) ---

router.get('/dashboard', authenticateWebUser, async (req, res) => {
    try {
        // req.user.userId is the database _id string from JWT
        const data = await getDashboardStats(req.user.userId);
        res.json(data);
    } catch (error) {
        logger.error('Dashboard data error:', error);
        res.status(500).json({ error: "Failed to load dashboard" });
    }
});

// --- REPORTS (Protected) ---

router.post('/reports/generate', authenticateWebUser, async (req, res) => {
    try {
        const { type, startDate, endDate } = req.body;
        
        if (!type || !startDate || !endDate) {
            return res.status(400).json({ error: "Missing report parameters" });
        }

        // We pass the PHONE number here, so the service can look up the full user profile
        // and then get the correct _id for transactions
        const pdfBuffer = await generateWebReport(req.user.phone, type, startDate, endDate);
        
        if (!pdfBuffer) {
            return res.status(400).json({ error: "Could not generate report" });
        }

        // Send PDF as a download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Fynax_${type}_${startDate}_${endDate}.pdf`);
        res.send(pdfBuffer);

    } catch (error) {
        logger.error('Web report gen error:', error);
        res.status(500).json({ error: "Failed to generate report" });
    }
});

export default router;


