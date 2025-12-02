import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { findOrCreateUser, updateUser } from '../db/userService.js';
import { sendTextMessage } from '../api/whatsappService.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

// Secret key for JWT (Web Login Token)
const JWT_SECRET = config.jwtSecret || 'replace_this_with_a_super_secure_random_string';

/**
 * Initiates the web login process.
 * 1. Checks if user exists.
 * 2. Generates a 6-digit OTP.
 * 3. Sends OTP via WhatsApp.
 */
export async function initiateWebLogin(phoneNumber) {
    // Normalize phone number (remove + or spaces)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    const user = await findOrCreateUser(cleanPhone); // Or findUser to restrict to existing users
    
    if (!user) {
        throw new Error("User not found.");
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Set expiry (10 minutes)
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    // Save to DB
    await updateUser(cleanPhone, { 
        webLoginOtp: otp, 
        webLoginOtpExpires: otpExpires 
    });

    // Send via WhatsApp Bot
    const message = `🔐 *Fynax Web Login*\n\nYour One-Time Password is: *${otp}*\n\nDo not share this code with anyone. It expires in 10 minutes.`;
    await sendTextMessage(cleanPhone, message);

    return { success: true, message: "OTP sent to WhatsApp" };
}

/**
 * Verifies the OTP and returns a JWT token for the frontend.
 */
export async function verifyWebLogin(phoneNumber, otpAttempt) {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const user = await findOrCreateUser(cleanPhone);

    if (!user || !user.webLoginOtp || !user.webLoginOtpExpires) {
        throw new Error("Invalid request or OTP expired.");
    }

    if (new Date() > user.webLoginOtpExpires) {
        throw new Error("OTP has expired. Please request a new one.");
    }

    if (user.webLoginOtp !== otpAttempt) {
        throw new Error("Invalid OTP.");
    }

    // Clear OTP after success
    await updateUser(cleanPhone, { webLoginOtp: null, webLoginOtpExpires: null });

    // Generate JWT Token (Valid for 7 days)
    const token = jwt.sign(
        { userId: user._id, phone: user.whatsappId, businessName: user.businessName },
        JWT_SECRET,
        { expiresIn: '7d' }
    );

    return { 
        success: true, 
        token, 
        user: { 
            businessName: user.businessName, 
            currency: user.currency,
            email: user.email 
        } 
    };
}

// Middleware to protect web routes
export function authenticateWebUser(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) return res.status(401).json({ error: "Access denied" });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(403).json({ error: "Invalid token" });
    }
}

