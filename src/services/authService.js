import jwt from 'jsonwebtoken';

/**
 * --- Auth Middleware (Checkpoint 1) ---
 * Verifies the JWT.
 * It checks for the token in two places:
 * 1. The 'Authorization: Bearer ...' header (for API calls)
 * 2. A query parameter '?token=...' (for file download links)
 */
export function authenticateToken(req, res, next) {
    let token = req.headers['authorization'];
    
    if (token) {
        // Standard Bearer token
        token = token.split(' ')[1];
    } else if (req.query.token) {
        // Token from query parameter (for downloads)
        token = req.query.token;
    }

    if (token == null) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token.' });
        }
        
        req.user = user; // Attach user payload
        next(); // Proceed
    });
}

/**
 * --- Admin-Only Middleware (Checkpoint 2) ---
 * Checks if the user (verified by authenticateToken) has the 'admin' role.
 */
export function adminOnly(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next(); // User is an admin, proceed.
    } else {
        return res.status(403).json({ message: 'Forbidden. Admin access required.' });
    }
}
