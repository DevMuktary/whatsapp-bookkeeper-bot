import OpenAI from 'openai';
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';
import * as advisorService from './advisorService.js';
import * as onboardingService from './onboardingService.js';

const deepseek = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com/v1" });

// --- TOOL DEFINITIONS (Unchanged) ---
const onboardingTools = [ { type: "function", function: { name: 'onboardUser', description: "Saves a new user's business name and email address. Generates and sends a 6-digit OTP to their email for verification.", parameters: { type: 'object', properties: { businessName: { type: 'string' }, email: { type: 'string' } }, required: ['businessName', 'email'] } } }, { type: "function", function: { name: 'verifyEmailOTP', description: "Verifies the 6-digit OTP that the user provides from their email.", parameters: { type: 'object', properties: { otp: { type: 'string', description: "The 6-digit code from the user." } }, required: ['otp'] } } }, { type: "function", function: { name: 'setCurrency', description: "Sets the user's preferred currency. Infer the standard 3-letter currency code (e.g., NGN for Naira, USD for Dollar).", parameters: { type: 'object', properties: { currencyCode: { type: 'string', description: "The 3-letter currency code, e.g., NGN, USD, GHS." } }, required: ['currencyCode'] } } }, ];
const mainUserTools = [ { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory.', parameters: { type: 'object', properties: { productName: { type: 'string' }, quantitySold: { type: 'number' }, totalAmount: { type: 'number' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } }, { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense (not a product sale).', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['income', 'expense'] }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string' } }, required: ['type', 'amount', 'description'] } } }, { type: "function", function: { name: 'addProduct', description: 'Adds new products to inventory or sets opening balance.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } }, { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } }, { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of finances for the current month.', parameters: { type: 'object', properties: {} } } }, { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions.', parameters: { type: 'object', properties: {} } } }, { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit.', parameters: { type: 'object', properties: {} } } }, { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement.', parameters: { type: 'object', properties: {} } } }, { type: "function", function: { name: 'changeWebsitePassword', description: "Changes the user's password for the Fynax website dashboard.", parameters: { type: 'object', properties: { newPassword: { type: 'string', description: 'The new password. Must be at least 6 characters.' } }, required: ['newPassword'] } } }, { type: "function", function: { name: 'requestLiveChat', description: "Connects the user to a human support agent.", parameters: { type: 'object', properties: { issue: { type: 'string', description: "A brief summary of the user's issue." } }, required: ['issue'] } } }, { type: "function", function: { name: 'getFinancialDataForAnalysis', description: "Fetches a complete snapshot of the user's monthly data for analysis.", parameters: { type: 'object', properties: {} } } } ];
const availableTools = { logSale: accountingService.logSale, logTransaction: accountingService.logTransaction, addProduct: accountingService.addProduct, getInventory: accountingService.getInventory, getMonthlySummary: accountingService.getMonthlySummary, generateTransactionReport: reportService.generateTransactionReport, generateInventoryReport: reportService.generateInventoryReport, generatePnLReport: reportService.generatePnLReport, changeWebsitePassword: authService.changePasswordFromBot, requestLiveChat: liveChatService.requestLiveChat, getFinancialDataForAnalysis: advisorService.getFinancialDataForAnalysis, onboardUser: onboardingService.onboardUser, verifyEmailOTP: onboardingService.verifyEmailOTP, setCurrency: onboardingService.setCurrency };

// --- ONBOARDING AI PROCESS ---
export async function processOnboardingMessage(text, collections, senderId, user, conversation) {
    const onboardingSystemInstruction = `You are Fynax Bookkeeper's onboarding assistant...`; // Full prompt
    const messages = [ { role: "system", content: onboardingSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, onboardingTools, collections, senderId, user, conversation);
}

// --- MAIN AI PROCESS ---
export async function processMessageWithAI(text, collections, senderId, user, conversation) {
    const mainSystemInstruction = `You are 'Fynax Bookkeeper', an expert AI financial advisor...`; // Full prompt
    const messages = [ { role: "system", content: mainSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, mainUserTools, collections, senderId, user, conversation);
}

// --- Reusable AI Cycle Function (NEW, PERMANENTLY RELIABLE VERSION) ---
async function runAiCycle(messages, tools, collections, senderId, user, conversation) {
    const { conversationsCollection } = collections;
    const newHistoryEntries = [messages[messages.length-1]]; // Start with the user's message

    try {
        // We only make ONE call to the AI.
        const response = await deepseek.chat.completions.create({ model: "deepseek-chat", messages, tools, tool_choice: "auto" });
        const responseMessage = response.choices[0].message;

        let finalContent;

        // Check if the AI wants to call a tool
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            const toolCall = responseMessage.tool_calls[0];
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments);
            const selectedTool = availableTools[functionName];

            if (selectedTool) {
                // Execute the tool
                const functionResult = await selectedTool(functionArgs, collections, senderId, user);
                // Manually format the result into a user-friendly string
                finalContent = formatToolResponse(functionResult, functionName);
            } else {
                finalContent = "Sorry, I can't do that right now.";
            }
            // Add the final, human-readable response to the history
            newHistoryEntries.push({ role: 'assistant', content: finalContent });

        } else {
            // If no tool was called, the final content is just the AI's direct response.
            finalContent = responseMessage.content;
            newHistoryEntries.push(responseMessage);
        }

        // Save the clean history (user message + final assistant response)
        saveHistory(conversationsCollection, senderId, conversation.history, newHistoryEntries);

        if (finalContent) {
            return finalContent.trim();
        }

    } catch (error) {
        console.error("Error in AI cycle:", error);
        throw error; // Let the main handler catch it and send a generic error message
    }

    return null;
}

// --- HELPER: Manually formats tool results into user-friendly text ---
function formatToolResponse(result, functionName) {
    if (!result) {
        return "Sorry, there was an error processing your request.";
    }
    if (!result.success) {
        return result.message || "Sorry, I couldn't complete that request.";
    }

    // Simple success messages are returned directly
    if (result.message) {
        return result.message;
    }

    // Custom formatters for data-heavy tools
    switch (functionName) {
        case 'getMonthlySummary':
            return `Here is your summary for ${result.month}:\n\n- Total Income: *${result.currency} ${result.income.toLocaleString()}*\n- Total Expenses: *${result.currency} ${result.expense.toLocaleString()}*\n- Net Balance: *${result.currency} ${result.net.toLocaleString()}*`;
        
        case 'getInventory':
            if (!result.products || result.products.length === 0) {
                return "You have no products in your inventory.";
            }
            let inventoryText = "Here is your current inventory:\n\n";
            result.products.forEach(p => {
                inventoryText += `- *${p.name}:* ${p.stock} units @ ${result.currency} ${p.price.toLocaleString()}\n`;
            });
            return inventoryText;

        default:
            return "Your request has been processed successfully.";
    }
}

// --- HELPER: Saves conversation history ---
async function saveHistory(conversationsCollection, senderId, existingHistory = [], newHistoryEntries = []) {
    const finalHistoryToSave = [...existingHistory, ...newHistoryEntries];
    const MAX_USER_TURNS = 5;
    let userMessageCount = 0;
    let startIndex = -1;
    for (let i = finalHistoryToSave.length - 1; i >= 0; i--) {
        if (finalHistoryToSave[i].role === 'user') { 
            userMessageCount++; 
            if (userMessageCount === MAX_USER_TURNS) { 
                startIndex = i; 
                break; 
            } 
        }
    }
    const prunedHistory = startIndex !== -1 ? finalHistoryToSave.slice(startIndex) : finalHistoryToSave;
    await conversationsCollection.updateOne({ userId: senderId }, { $set: { history: prunedHistory } });
}
