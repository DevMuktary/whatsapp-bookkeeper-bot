import jwt from 'jsonwebtoken';

/**
 * --- Auth Middleware ---
 * This function acts as a checkpoint for secure routes.
 * It verifies the JWT from the Authorization header.
 */
export function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    // The header format is "Bearer TOKEN"
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) {
        // No token provided
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    // Verify the token
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            // Token is invalid or expired
            return res.status(403).json({ message: 'Invalid or expired token.' });
        }
        
        // The token is valid!
        // We attach the user's data (from the token) to the request object
        // so our next function (the endpoint) can use it.
        req.user = user;
        next(); // Proceed to the endpoint
    });
}
