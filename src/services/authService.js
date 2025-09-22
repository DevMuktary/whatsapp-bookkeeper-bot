import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { normalizePhone } from '../utils/helpers.js';

// --- Validation Schema ---
// Ensures the input data is in the correct format before we even touch the database.
const loginSchema = Joi.object({
    phone: Joi.string().min(10).max(15).required(),
    password: Joi.string().min(6).required()
});

/**
 * --- API Endpoint: Login a User ---
 * Handles a login request from the website.
 */
export async function loginUser(req, res, collections) {
    const { usersCollection } = collections;

    // 1. Validate Input
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { phone, password } = value;
    
    // 2. Normalize Phone & Find User
    const normalizedJid = normalizePhone(phone);
    if (!normalizedJid) {
        return res.status(400).json({ message: "Invalid phone number format." });
    }

    const user = await usersCollection.findOne({ userId: normalizedJid });
    if (!user) {
        return res.status(404).json({ message: "User not found. Please register on WhatsApp first." });
    }

    // 3. Check if Blocked
    if (user.isBlocked) {
        return res.status(403).json({ message: "This account has been suspended." });
    }

    // 4. Check Password
    const isPasswordValid = await bcrypt.compare(password, user.websitePassword);
    if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid phone or password." });
    }

    // 5. Generate JWT Token
    // The token is a secure key that proves the user is logged in.
    const token = jwt.sign(
        { 
            userId: user.userId, 
            role: user.role,
            storeName: user.storeName 
        },
        process.env.JWT_SECRET,
        { expiresIn: '8h' } // Token lasts for 8 hours
    );

    // 6. Send Success Response
    res.status(200).json({
        message: "Login successful",
        token: token,
        user: {
            storeName: user.storeName,
            role: user.role
        }
    });
}
