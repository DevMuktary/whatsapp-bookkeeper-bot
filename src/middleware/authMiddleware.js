import jwt from 'jsonwebtoken';

/**
 * --- Auth Middleware (Checkpoint 1) ---
 * Verifies the JWT from the Authorization header.
 * Attaches 'req.user' if valid.
 */
export function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token.' });
        }
        
        req.user = user; // Attach user payload (userId, role, etc.)
        next(); // Proceed to the next checkpoint or the endpoint
    });
}

/**
 * --- Admin-Only Middleware (Checkpoint 2) ---
 * Checks if the user (verified by authenticateToken) has the 'admin' role.
 * This MUST run *after* authenticateToken.
 */
export function adminOnly(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next(); // User is an admin, proceed.
    } else {
        return res.status(403).json({ message: 'Forbidden. Admin access required.' });
    }
}
