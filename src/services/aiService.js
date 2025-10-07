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
    { type: "function", function: { name: 'onboardUser', /* ... */ } },
    { type: "function", function: { name: 'verifyEmailOTP', /* ... */ } },
    { type: "function", function: { name: 'setCurrency', /* ... */ } },
];
const mainUserTools = [
    { type: "function", function: { name: 'logSale', /* ... */ } },
    { type: "function", function: { name: 'logTransaction', /* ... */ } },
    { type: "function", function: { name: 'addProduct', /* ... */ } },
    { type: "function", function: { name: 'getInventory', /* ... */ } },
    { type: "function", function: { name: 'getMonthlySummary', /* ... */ } },
    { type: "function", function: { name: 'generateTransactionReport', /* ... */ } },
    { type: "function", function: { name: 'generateInventoryReport', /* ... */ } },
    { type: "function", function: { name: 'generatePnLReport', /* ... */ } },
    { type: "function", function: { name: 'changeWebsitePassword', /* ... */ } },
    { type: "function", function: { name: 'requestLiveChat', /* ... */ } },
    { type: "function", function: { name: 'getFinancialDataForAnalysis', /* ... */ } },
];
const availableTools = { 
    logSale: accountingService.logSale,
    logTransaction: accountingService.logTransaction, 
    addProduct: accountingService.addProduct, 
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
    const onboardingSystemInstruction = `You are Fynax Bookkeeper's onboarding assistant...`; // (Full prompt)
    const messages = [ { role: "system", content: onboardingSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, onboardingTools, collections, senderId, user, conversation);
}

// --- MAIN AI PROCESS ---
export async function processMessageWithAI(text, collections, senderId, user, conversation) {
    const mainSystemInstruction = `You are 'Fynax Bookkeeper', an expert AI financial advisor...`; // (Full prompt)
    const messages = [ { role: "system", content: mainSystemInstruction }, ...(conversation.history || []), { role: "user", content: text } ];
    return await runAiCycle(messages, mainUserTools, collections, senderId, user, conversation);
}

// --- Reusable AI Cycle Function (NEW RELIABLE VERSION) ---
async function runAiCycle(messages, tools, collections, senderId, user, conversation) {
    const { conversationsCollection } = collections;
    
    // We only save the user's message to history for now
    const newHistoryEntries = [messages[messages.length-1]];

    try {
        // First and ONLY call to the AI for this turn if a tool is used
        const response = await deepseek.chat.completions.create({ model: "deepseek-chat", messages, tools, tool_choice: "auto" });
        const responseMessage = response.choices[0].message;

        // Add the AI's immediate response to our history
        newHistoryEntries.push(responseMessage);

        // Check if the AI wants to call a tool
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            
            // --- NEW RELIABLE LOGIC ---
            // Execute the tool, but DO NOT call the AI again.
            // We will format the response ourselves.

            const toolCall = responseMessage.tool_calls[0]; // We'll handle one tool call at a time for simplicity
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments);
            const selectedTool = availableTools[functionName];

            if (selectedTool) {
                const functionResult = await selectedTool(functionArgs, collections, senderId, user);
                
                // Manually format the response instead of asking the AI
                let toolResponseText = formatToolResponse(functionResult, functionName);

                // Add the (pretend) tool result and final assistant message to history
                newHistoryEntries.push(
                    { role: 'tool', tool_call_id: toolCall.id, name: functionName, content: JSON.stringify(functionResult) },
                    { role: 'assistant', content: toolResponseText }
                );
                
                // Save history and return the formatted text
                saveHistory(conversationsCollection, senderId, conversation.history, newHistoryEntries);
                return toolResponseText;
            }
        }

        // If no tool was called, just return the AI's text response
        if (responseMessage.content) {
            saveHistory(conversationsCollection, senderId, conversation.history, newHistoryEntries);
            return responseMessage.content.trim();
        }

    } catch (error) {
        console.error("Error in AI cycle:", error);
        throw error;
    }

    return null;
}

// --- NEW HELPER: Manually formats tool results into user-friendly text ---
function formatToolResponse(result, functionName) {
    if (!result || !result.success) {
        return result.message || "Sorry, I couldn't complete that request.";
    }

    // Simple success messages
    if (result.message) {
        return result.message;
    }

    // Custom formatters for data-heavy tools
    switch (functionName) {
        case 'getMonthlySummary':
            return `Here is your summary for ${result.month}:\n\n- Total Income: *${result.currency} ${result.income.toLocaleString()}*\n- Total Expenses: *${result.currency} ${result.expense.toLocaleString()}*\n- Net Balance: *${result.currency} ${result.net.toLocaleString()}*`;
        
        case 'getInventory':
            let inventoryText = "Here is your current inventory:\n\n";
            result.products.forEach(p => {
                inventoryText += `- *${p.name}:* ${p.stock} units @ ${result.currency} ${p.price.toLocaleString()}\n`;
            });
            return inventoryText;

        default:
            return "Your request has been processed successfully.";
    }
}

// --- NEW HELPER: Saves conversation history ---
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
