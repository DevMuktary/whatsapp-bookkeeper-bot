import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const WHATSAPP_GRAPH_URL = 'https://graph.facebook.com/v20.0';

export async function configureWhatsappCommands() {
    try {
        const commands = [
            { command: "menu", description: "Show the Main Menu 📋" },
            { command: "sale", description: "Log a New Sale 💰" },
            { command: "expense", description: "Log an Expense 💸" },
            { command: "stock", description: "Check Inventory 📦" },
            { command: "report", description: "Generate PDF Report 📊" },
            { command: "bank", description: "Manage Bank Accounts 🏦" }
        ];

        const url = `${WHATSAPP_GRAPH_URL}/${config.whatsapp.phoneNumberId}/commands`;
        
        await axios.post(url, { commands }, {
            headers: {
                'Authorization': `Bearer ${config.whatsapp.token}`,
                'Content-Type': 'application/json'
            }
        });

        logger.info('✅ WhatsApp Persistent Menu (Commands) configured successfully.');
    } catch (error) {
        logger.error('Failed to configure WhatsApp commands:', error.response ? error.response.data : error.message);
    }
}
