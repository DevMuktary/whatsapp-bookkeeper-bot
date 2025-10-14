// src/taskHandler.js

import * as aiService from './services/aiService.js';
import * as accountingService from './services/accountingService.js';
import * as reportService from './services/reportService.js';
import * as whatsappService from './services/whatsappService.js';

// A map to connect tool names to their actual database functions.
const toolExecutors = {
    'addProduct': accountingService.addProduct,
    'logSale': accountingService.logSale,
    'logTransaction': accountingService.logTransaction,
    'generateSalesReport': reportService.generateSalesReport,
    'generateInventoryReport': reportService.generateInventoryReport,
    'generatePnLReport': reportService.generatePnLReport,
    'generateTransactionReport': reportService.generateTransactionReport,
};

/**
 * Manages the multi-step process of collecting data for a specific task.
 * @param {boolean} isFirstStep - Indicates if this is the start of the task.
 */
export async function handleTaskStep(message, collections, user, conversation, isFirstStep = false) {
    const { conversationsCollection } = collections;
    const senderId = user.userId;
    const toolName = conversation.state.replace('collecting_', '').replace('_details', '');

    // On the first step, we don't have a user message yet, just the intent.
    // The AI's job is to send the very first question.
    const messageForAI = isFirstStep ? `I want to ${toolName.replace(/([A-Z])/g, ' $1').toLowerCase()}` : message.text;

    // Call the specialized Worker AI to process the message.
    const aiResponse = await aiService.processTaskMessage(messageForAI, toolName, collections, senderId);
    
    try {
        // Check if the AI's response is the final JSON data package.
        const collectedData = JSON.parse(aiResponse);
        
        // --- EXECUTION STEP ---
        // We have the data! Now, execute the correct database function.
        const executor = toolExecutors[toolName];
        if (executor) {
            console.log(`Executing tool '${toolName}' with data:`, collectedData);
            const result = await executor(collectedData, collections, senderId, user);
            
            // Send the final success/failure message to the user.
            await whatsappService.sendMessage(senderId, result.message);
        } else {
            throw new Error(`No executor found for tool: ${toolName}`);
        }

        // --- FINAL STEP ---
        // The task is complete. Reset the user's state to idle.
        await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'idle' } });
        // Optionally, send a follow-up menu.
        await whatsappService.sendMessage(senderId, "Is there anything else I can help you with?");

    } catch (error) {
        // If JSON.parse fails, it's just a regular conversational message.
        // Send the AI's question/response to the user and wait for their next reply.
        await whatsappService.sendMessage(senderId, aiResponse);
    }
}
