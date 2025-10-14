import * as aiService from './services/aiService.js';
import * as accountingService from './services/accountingService.js';
import * as reportService from './services/reportService.js';
import * as whatsappService from './services/whatsappService.js';

// --- THE ROBUST JSON EXTRACTOR ---
// This is the same successful utility we used to fix onboarding.
function extractJsonFromString(str) {
    const jsonMatch = str.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return null;
    }
    try {
        return JSON.parse(jsonMatch[0]);
    } catch (error) {
        console.error("Failed to parse extracted JSON:", error);
        return null;
    }
}

const toolExecutors = {
    'addProduct': accountingService.addProduct,
    'logSale': accountingService.logSale,
    'logTransaction': accountingService.logTransaction,
    'getInventory': accountingService.getInventory, // Added for completeness
    'generateSalesReport': reportService.generateSalesReport,
    'generateInventoryReport': reportService.generateInventoryReport,
    'generatePnLReport': reportService.generatePnLReport,
    'generateTransactionReport': reportService.generateTransactionReport,
};

/**
 * Manages the multi-step process of collecting data for a specific task.
 */
export async function handleTaskStep(message, collections, user, conversation, isFirstStep = false) {
    const { conversationsCollection } = collections;
    const senderId = user.userId;
    const toolName = conversation.state.replace('collecting_', '').replace('_details', '');

    const messageForAI = isFirstStep ? `I want to ${toolName.replace(/([A-Z])/g, ' $1').toLowerCase()}` : message.text;

    const aiResponse = await aiService.processTaskMessage(messageForAI, toolName, collections, senderId);
    
    // THE FIX: Instead of a fragile try/catch, we use our robust extractor.
    const collectedData = extractJsonFromString(aiResponse);

    if (collectedData) {
        // --- EXECUTION STEP ---
        // We have the data! Now, execute the correct database function.
        const executor = toolExecutors[toolName];
        if (executor) {
            console.log(`Executing tool '${toolName}' with data:`, collectedData);
            const result = await executor(collectedData, collections, senderId);
            
            await whatsappService.sendMessage(senderId, result.message);
        } else {
            console.error(`No executor found for tool: ${toolName}`);
            await whatsappService.sendMessage(senderId, "I'm sorry, I had an internal error trying to complete that task.");
        }

        // --- FINAL STEP ---
        // The task is complete. Reset the user's state to idle.
        await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'idle' } });
        // Send a follow-up menu/prompt.
        setTimeout(() => {
             whatsappService.sendInteractiveMessage(senderId, "Is there anything else I can help with?", [
                { id: 'log_sale', title: 'Log a Sale' },
                { id: 'log_expense', title: 'Log an Expense' },
                { id: 'add_stock', title: 'Add New Stock' },
            ]);
        }, 1000); // Small delay for a more natural feel

    } else {
        // It's just a regular conversational message.
        // Send the AI's question/response to the user and wait for their next reply.
        await whatsappService.sendMessage(senderId, aiResponse);
    }
}
