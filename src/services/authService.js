import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { normalizePhone } from '../utils/helpers.js';

const SALT_ROUNDS = 10; // Added salt rounds for hashing

// --- Validation Schema ---
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
    const token = jwt.sign(
        { 
            userId: user.userId, 
            role: user.role,
            storeName: user.storeName 
        },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
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

/**
 * --- BOT TOOL: Change User's Web Password ---
 * Handles a request from the WhatsApp bot AI.
 */
export async function changePasswordFromBot(args, collections, senderId) {
    const { usersCollection } = collections;
    const { newPassword } = args;

    if (!newPassword || newPassword.length < 6) {
        return { success: false, message: "Password must be at least 6 characters long. Please try again." };
    }

    try {
        const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
        
        await usersCollection.updateOne(
            { userId: senderId },
            { $set: { websitePassword: hashedPassword } }
        );

        return { success: true, message: "Your website password has been successfully changed." };

    } catch (error) {
        console.error("Error in changePasswordFromBot:", error);
        return { success: false, message: "An error occurred while trying to change your password." };
    }
}
