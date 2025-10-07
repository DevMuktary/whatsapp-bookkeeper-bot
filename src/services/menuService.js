import { sendInteractiveMessage } from './whatsappService.js';

/**
 * Sends the initial welcome menu after a user successfully onboards.
 * @param {string} senderId - The user's WhatsApp ID.
 */
export async function sendOnboardingMenu(senderId) {
    const bodyText = "🎉 Setup Complete! You're all set. What would you like to do first?";
    
    const buttons = [
        { id: 'log_sale', title: 'Log a Sale 💰' },
        { id: 'log_expense', title: 'Log an Expense 💸' },
        { id: 'add_stock', title: 'Add New Stock 📦' }
    ];

    await sendInteractiveMessage(senderId, bodyText, buttons);
}
