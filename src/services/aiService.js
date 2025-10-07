import OpenAI from 'openai';
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';
import * as advisorService from './advisorService.js';
import * as onboardingService from './onboardingService.js';

const deepseek = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com/v1" });

// --- TOOL DEFINITIONS (Unchanged) ---
const onboardingTools = [
    { type: "function", function: { name: 'onboardUser', description: "Saves a new user's business name and email address. Generates and sends a 6-digit OTP to their email for verification.", parameters: { type: 'object', properties: { businessName: { type: 'string' }, email: { type: 'string' } }, required: ['businessName', 'email'] } } },
    { type: "function", function: { name: 'verifyEmailOTP', description: "Verifies the 6-digit OTP that the user provides from their email.", parameters: { type: 'object', properties: { otp: { type: 'string', description: "The 6-digit code from the user." } }, required: ['otp'] } } },
    { type: "function", function: { name: 'setCurrency', description: "Sets the user's preferred currency. Infer the standard 3-letter currency code (e.g., NGN for Naira, USD for Dollar).", parameters: { type: 'object', properties: { currencyCode: { type: 'string', description: "The 3-letter currency code, e.g., NGN, USD, GHS." } }, required: ['currencyCode'] } } },
];
const mainUserTools = [
    { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory.', parameters: { type: 'object', properties: { productName: { type: 'string' }, quantitySold: { type: 'number' }, totalAmount: { type: 'number' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } },
    { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense (not a product sale).', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['income', 'expense'] }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string' } }, required: ['type', 'amount', 'description'] } } },
    { type: "function", function: { name: 'addProduct', description: 'Adds new products to inventory.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
    { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of finances for the current month.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'changeWebsitePassword', description: "Changes the user's password for the Fynax website dashboard.", parameters: { type: 'object', properties: { newPassword: { type: 'string', description: 'The new password. Must be at least 6 characters.' } }, required: ['newPassword'] } } },
    { type: "function", function: { name: 'requestLiveChat', description: "Connects the user to a human support agent.", parameters: { type: 'object', properties: { issue: { type: 'string', description: "A brief summary of the user's issue." } }, required: ['issue'] } } },
    { type: "function", function: { name: 'getFinancialDataForAnalysis', description: "Fetches a complete snapshot of the user's monthly data for analysis.", parameters: { type: 'object', properties: {} } } }
];
const availableTools = { 
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
    setOpeningBalance: accountingService.setOpeningBalance, 
    getInventory: accountingService.getInventory, 
    getMonthlySummary: accountingService.getMonthlySummary, 
    generateTransactionReport: reportService.generateTransactionReport, 
    generateInventoryReport: reportService.generateInventoryReport, 
    generatePnLReport: reportService.generatePnLReport,
    changeWebsitePassword: authService.changePasswordFromBot,
    requestLiveChat: liveChatService.requestLiveChat,
    getFinancialDataForAnalysis: advisorService.getFinancialDataForAnalysis,
    onboardUser: onboardingService.onboardUser,
    verifyEmailOTP: onboardingService.verifyEmailOTP,
    setCurrency: onboardingService.setCurrency,
};

// --- ONBOARDING AI PROCESS ---
export async function processOnboardingMessage(text, collections, senderId, user, conversation) {
    const onboardingSystemInstruction = `You are Fynax Bookkeeper's onboarding assistant...`; // This prompt is fine
    const messages = [ { role: "system", content: onboardingSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, onboardingTools, collections, senderId, user, conversation);
}

// --- MAIN AI PROCESS ---
export async function processMessageWithAI(text, collections, senderId, user, conversation) {
    const mainSystemInstruction = `You are 'Fynax Bookkeeper', an expert AI financial advisor...`; // This prompt is fine
    const messages = [ { role: "system", content: mainSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, mainUserTools, collections, senderId, user, conversation);
}

// --- Reusable AI Cycle Function (UPDATED with THE PERMANENT FIX) ---
async function runAiCycle(messages, tools, collections, senderId, user, conversation) {
    const { conversationsCollection } = collections;
    let newHistoryEntries = [messages[messages.length - 1]];

    try {
        const response = await deepseek.chat.completions.create({ model: "deepseek-chat", messages, tools, tool_choice: "auto" });
        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            messages.push(responseMessage);
            newHistoryEntries.push(responseMessage);

            const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
                try {
                    const functionName = toolCall.function.name;
                    const functionArgs = JSON.parse(toolCall.function.arguments);
                    const selectedTool = availableTools[functionName];
                    if (selectedTool) {
                        const functionResult = await selectedTool(functionArgs, collections, senderId, user);
                        return { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(functionResult) };
                    }
                    return { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify({ success: false, message: `Error: Tool '${functionName}' not found.` }) };
                } catch (error) {
                    console.error(`Error parsing or executing tool call ${toolCall.id}:`, error);
                    return { tool_call_id: toolCall.id, role: "tool", name: toolCall.function.name, content: JSON.stringify({ success: false, message: "There was an error processing the tool's arguments." }) };
                }
            });
            
            const toolResponses = await Promise.all(toolExecutionPromises);
            
            if (toolResponses.length > 0) {
                messages.push(...toolResponses);
                newHistoryEntries.push(...toolResponses);

                // --- THIS IS THE PERMANENT FIX ---
                // We make the second call WITHOUT the 'tools' parameter.
                // The AI's only job is to summarize, not call more tools.
                const secondResponse = await deepseek.chat.completions.create({ model: "deepseek-chat", messages });
                // --- END OF FIX ---

                responseMessage = secondResponse.choices[0].message;
            } else {
                responseMessage = { role: 'assistant', content: "I encountered an issue while trying to process that request. Could you please try rephrasing?" };
            }
        }

        newHistoryEntries.push(responseMessage);
        
        // Robust History Pruning
        const existingHistory = conversation.history || [];
        const finalHistoryToSave = [...existingHistory, ...newHistoryEntries];
        const MAX_USER_TURNS = 5;
        let userMessageCount = 0;
        let startIndex = -1;
        for (let i = finalHistoryToSave.length - 1; i >= 0; i--) {
            if (finalHistoryToSave[i].role === 'user') { userMessageCount++; if (userMessageCount === MAX_USER_TURNS) { startIndex = i; break; } }
        }
        const prunedHistory = startIndex !== -1 ? finalHistoryToSave.slice(startIndex) : finalHistoryToSave;

        await conversationsCollection.updateOne({ userId: senderId }, { $set: { history: prunedHistory } });

        if (responseMessage.content) {
            return responseMessage.content.replace(/<\|.*?\|>/g, '').trim();
        }

    } catch (error) {
        console.error("Error in AI cycle:", error);
        throw error;
    }
    return null;
}
