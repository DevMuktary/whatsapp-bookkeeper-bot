import OpenAI from 'openai';
import * as accountingService from './accountingService.js';
import * as reportService from './reportService.js';
import * as authService from './authService.js';
import * as liveChatService from './liveChatService.js';
import * as advisorService from './advisorService.js';

// --- AI Client Initialization ---
const deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
});

// --- AI Tool Definitions ---
const tools = [
  { type: "function", function: { name: 'logSale', description: 'Logs a sale of a product from inventory.', parameters: { type: 'object', properties: { productName: { type: 'string' }, quantitySold: { type: 'number' }, totalAmount: { type: 'number' } }, required: ['productName', 'quantitySold', 'totalAmount'] } } },
  { type: "function", function: { name: 'logTransaction', description: 'Logs a generic income or expense (not a product sale).', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['income', 'expense'] }, amount: { type: 'number' }, description: { type: 'string' }, category: { type: 'string' } }, required: ['type', 'amount', 'description'] } } },
  { type: "function", function: { name: 'addProduct', description: 'Adds new products to inventory.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'setOpeningBalance', description: 'Sets the initial inventory or opening balance.', parameters: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, cost: { type: 'number' }, price: { type: 'number' }, stock: { type: 'number' } }, required: ['productName', 'cost', 'price', 'stock'] } } }, required: ['products'] } } },
  { type: "function", function: { name: 'getInventory', description: 'Retrieves a list of all products in inventory.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'getMonthlySummary', description: 'Gets a quick text summary of finances for the current month.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateTransactionReport', description: 'Generates a PDF file of all financial transactions.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generateInventoryReport', description: 'Generates a PDF file of inventory, sales, and profit.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'generatePnLReport', description: 'Generates a professional Profit and Loss (P&L) PDF statement.', parameters: { type: 'object', properties: {} } } },
  { type: "function", function: { name: 'changeWebsitePassword', description: "Changes the user's password for the Fynax website dashboard.", parameters: { type: 'object', properties: { newPassword: { type: 'string', description: 'The new password. Must be at least 6 characters.' } }, required: ['newPassword'] } } },
  { type: "function", function: { name: 'requestLiveChat', description: "Connects the user to a human support agent.", parameters: { type: 'object', properties: { issue: { type: 'string', description: "A brief summary of the user's issue." } }, required: ['issue'] } } },
  { type: "function", function: { name: 'getFinancialDataForAnalysis', description: "Fetches a complete snapshot of the user's monthly summary, top expenses, and inventory status. Use this tool when the user asks for 'advice', 'analysis', 'suggestions', or 'how to improve'.", parameters: { type: 'object', properties: {} } } }
];

// --- Tool Function Mapping ---
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
    getFinancialDataForAnalysis: advisorService.getFinancialDataForAnalysis
};

// --- Core AI Processing Function (MIGRATED) ---
export async function processMessageWithAI(text, collections, senderId, user) {
    const { conversationsCollection } = collections;
    
    try {
        const conversation = await conversationsCollection.findOne({ userId: senderId });
        const savedHistory = conversation ? conversation.history : [];
        
        const systemInstruction = `You are 'Fynax Bookkeeper', an expert AI financial advisor. Your name is Fynax Bookkeeper. Follow these rules:
1.  **Use Tools:** Your primary job is to use tools to perform actions (log sales, change passwords, etc.) or gather data.
2.  **Stay in Scope:** Your abilities are: bookkeeping, inventory, reporting, password changes, live support, and **financial analysis**. Do not answer questions outside this scope.
3.  **Live Support:** If the user asks for a 'human' or 'support', use the 'requestLiveChat' tool.
4.  **CRITICAL: Financial Advisor Role:**
    * If a user asks for 'advice', 'analysis', 'suggestions', 'how to improve', or 'what am I doing wrong?', you MUST use the \`getFinancialDataForAnalysis\` tool.
    * This tool will return a JSON object with the user's financial data.
    * When you get this data, your *only* job is to analyze it and give 3-5 short, clear, actionable bullet points of advice.
    * Start your reply with "Here's my analysis of your month so far:"
    * Base your advice *only* on the data provided. (e.g., "Your 'transport' costs are very high", "Your 'iPhone' product is very profitable").
5.  **Be Confident & Concise:** Speak as the expert. Never mention your tools or that you are an AI.`;
        
        const messages = [
            { role: "system", content: systemInstruction },
            ...savedHistory,
            { role: "user", content: text }
        ];

        let newHistoryEntries = [{ role: 'user', content: text }];

        const response = await deepseek.chat.completions.create({ 
            model: "deepseek-chat", 
            messages: messages, 
            tools: tools, 
            tool_choice: "auto" 
        });
        
        let responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
            messages.push(responseMessage);
            
            const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                const selectedTool = availableTools[functionName];
                if (selectedTool) {
                    // The 'sock' object is no longer passed to the tools
                    const functionResult = await selectedTool(functionArgs, collections, senderId, user);
                    return { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(functionResult) };
                }
                return null;
            });
            
            const toolResponses = (await Promise.all(toolExecutionPromises)).filter(Boolean);
            
            if (toolResponses.length > 0) {
                messages.push(...toolResponses);
                newHistoryEntries.push(responseMessage, ...toolResponses);
                const secondResponse = await deepseek.chat.completions.create({ model: "deepseek-chat", messages: messages });
                responseMessage = secondResponse.choices[0].message;
            } else {
                responseMessage = { role: 'assistant', content: "I'm not sure how to handle that. Could you please rephrase?" };
                newHistoryEntries = [{ role: 'user', content: text }];
            }
        }

        newHistoryEntries.push(responseMessage);

        // History pruning logic
        const finalHistoryToSave = [...savedHistory, ...newHistoryEntries];
        const MAX_TURNS_TO_KEEP = 5;
        let userMessageCount = 0;
        let startIndex = -1;
        for (let i = finalHistoryToSave.length - 1; i >= 0; i--) {
            if (finalHistoryToSave[i].role === 'user') {
                userMessageCount++;
                if (userMessageCount === MAX_TURNS_TO_KEEP) {
                    startIndex = i;
                    break;
                }
            }
        }
        const prunedHistory = startIndex !== -1 ? finalHistoryToSave.slice(startIndex) : finalHistoryToSave;
        
        await conversationsCollection.updateOne(
            { userId: senderId }, 
            { $set: { history: prunedHistory, updatedAt: new Date() } }, 
            { upsert: true }
        );

        // --- THE KEY CHANGE ---
        // We no longer send a message from here. We return the text.
        if (responseMessage.content) {
            const cleanContent = responseMessage.content.replace(/<\|.*?\|>/g, '').trim();
            if (cleanContent) {
                 return cleanContent;
            }
        }
        
    } catch (error) {
        console.error("Detailed error in AI message handler:", error);
        throw error;
    }

    return null; // Return null if there's nothing to say
}
