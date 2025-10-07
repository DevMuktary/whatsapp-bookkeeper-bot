import OpenAI from 'openai';
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';
import * as advisorService from './advisorService.js';
import * as onboardingService from './onboardingService.js';

const deepseek = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com/v1" });

// --- TOOL DEFINITIONS ---
const onboardingTools = [
    { type: "function", function: { name: 'onboardUser', description: "Saves a new user's business name and email address. Generates and sends a 6-digit OTP to their email for verification.", parameters: { type: 'object', properties: { businessName: { type: 'string' }, email: { type: 'string' } }, required: ['businessName', 'email'] } } },
    { type: "function", function: { name: 'verifyEmailOTP', description: "Verifies the 6-digit OTP that the user provides from their email.", parameters: { type: 'object', properties: { otp: { type: 'string', description: "The 6-digit code from the user." } }, required: ['otp'] } } },
    { type: "function", function: { name: 'setCurrency', description: "Sets the user's preferred currency. Infer the standard 3-letter currency code (e.g., NGN for Naira, USD for Dollar).", parameters: { type: 'object', properties: { currencyCode: { type: 'string', description: "The 3-letter currency code, e.g., NGN, USD, GHS." } }, required: ['currencyCode'] } } },
];
const mainUserTools = [
    { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory. This is the primary tool for recording sales.', parameters: { type: 'object', properties: { productName: { type: 'string', description: 'The name of the product sold, e.g., "iPhone 17 Air".' }, quantitySold: { type: 'number', description: 'The number of units sold.' }, totalAmount: { type: 'number', description: 'The total income received from the sale.' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } },
    { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense that is NOT a product sale, such as "rent", "utilities", or "service income".', parameters: { type: 'object', properties: { type: { type: 'string', description: 'The type of transaction, either "income" or "expense".' }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string', description: 'For expenses, a category like "rent", "utilities", "transport". Defaults to "Uncategorized".' } }, required: ['type', 'amount', 'description'] } } },
    { type: "function", function: { name: 'addProduct', description: 'Adds one or more new products to inventory. If a product already exists, this updates its price and adds to its stock.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
    { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of total income, expenses, and net balance for the current month.', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions. Use only when the user explicitly asks to "export", "download", or receive a "PDF report".', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit. Use only when the user explicitly asks for an "inventory report" or "profit report".', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement. Use only when the user asks for a "P&L" or "statement".', parameters: { type: 'object', properties: {} } } },
    { type: "function", function: { name: 'changeWebsitePassword', description: "Changes the user's password for the Fynax website dashboard.", parameters: { type: 'object', properties: { newPassword: { type: 'string', description: 'The new password. Must be at least 6 characters.' } }, required: ['newPassword'] } } },
    { type: "function", function: { name: 'requestLiveChat', description: "Connects the user to a human support agent. Use this if the user asks for a human, is stuck, or explicitly requests 'support' or 'accountant'.", parameters: { type: 'object', properties: { issue: { type: 'string', description: "A brief summary of the user's issue. e.g., 'User is confused about P&L report'." } }, required: ['issue'] } } },
    { type: "function", function: { name: 'getFinancialDataForAnalysis', description: "Fetches a complete snapshot of the user's monthly summary, top expenses, and inventory status. Use this tool when the user asks for 'advice', 'analysis', 'suggestions', or 'how to improve'.", parameters: { type: 'object', properties: {} } } }
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
    const onboardingSystemInstruction = `You are Fynax Bookkeeper's onboarding assistant...`; // Same as before
    const messages = [ { role: "system", content: onboardingSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, onboardingTools, collections, senderId, user, conversation);
}

// --- MAIN AI PROCESS ---
export async function processMessageWithAI(text, collections, senderId, user, conversation) {
    // --- UPDATED & STRICTER PROMPT ---
    const mainSystemInstruction = `You are 'Fynax Bookkeeper', an expert AI financial advisor. Your name is Fynax Bookkeeper. Your rules are absolute and you must never deviate.
1.  **Strictly Use Tools:** Your ONLY purpose is to use the tools provided. You do not have opinions or knowledge outside of these tools.
2.  **Stay in Scope:** If the user asks for anything that cannot be answered or performed by one of your tools, you MUST respond with: "I can only help with bookkeeping, inventory, and financial reports for your business. How can I assist with that?" Do not answer any other questions.
3.  **No Explanations:** Never mention your tools, that you are an AI, or how you work. Just perform the action.
4.  **Live Support:** If the user asks for a 'human', 'support', 'accountant', or seems very stuck, you MUST use the 'requestLiveChat' tool.
5.  **Financial Advisor Role:** If a user asks for 'advice', 'analysis', or 'how to improve', you MUST use the \`getFinancialDataForAnalysis\` tool. When you get data back from this tool, analyze it and provide 3-5 short, clear, actionable bullet points. Start your reply with "Here's my analysis of your month so far:"`;
    
    const messages = [ { role: "system", content: mainSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, mainUserTools, collections, senderId, user, conversation);
}

// --- Reusable AI Cycle Function ---
async function runAiCycle(messages, tools, collections, senderId, user, conversation) {
    const { conversationsCollection } = collections;
    let newHistoryEntries = [messages[messages.length - 1]];

    try {
        const response = await deepseek.chat.completions.create({ model: "deepseek-chat", messages, tools, tool_choice: "auto" });
        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
            messages.push(responseMessage);
            newHistoryEntries.push(responseMessage);

            const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                const selectedTool = availableTools[functionName];
                if (selectedTool) {
                    const functionResult = await selectedTool(functionArgs, collections, senderId, user);
                    return { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(functionResult) };
                }
                return null;
            });
            
            const toolResponses = (await Promise.all(toolExecutionPromises)).filter(Boolean);
            
            if (toolResponses.length > 0) {
                messages.push(...toolResponses);
                newHistoryEntries.push(...toolResponses);
                const secondResponse = await deepseek.chat.completions.create({ model: "deepseek-chat", messages, tools });
                responseMessage = secondResponse.choices[0].message;
            } else {
                responseMessage = { role: 'assistant', content: "I am not sure how to handle that. I can only help with bookkeeping tasks." };
            }
        }

        newHistoryEntries.push(responseMessage);
        
        // --- THE FIX: ROBUST HISTORY PRUNING ---
        const existingHistory = conversation.history || [];
        const finalHistoryToSave = [...existingHistory, ...newHistoryEntries];
        const MAX_USER_TURNS = 5;
        let userMessageCount = 0;
        let startIndex = -1;
        // Iterate backwards to find the start of the 5th-to-last user message
        for (let i = finalHistoryToSave.length - 1; i >= 0; i--) {
            if (finalHistoryToSave[i].role === 'user') {
                userMessageCount++;
                if (userMessageCount === MAX_USER_TURNS) {
                    startIndex = i;
                    break;
                }
            }
        }
        // If we found 5 user turns, slice from there. Otherwise, keep the whole history.
        const prunedHistory = startIndex !== -1 ? finalHistoryToSave.slice(startIndex) : finalHistoryToSave;

        await conversationsCollection.updateOne(
            { userId: senderId }, 
            { $set: { history: prunedHistory } }
        );

        if (responseMessage.content) {
            return responseMessage.content.replace(/<\|.*?\|>/g, '').trim();
        }

    } catch (error) {
        console.error("Error in AI cycle:", error);
        throw error;
    }
    return null;
}
