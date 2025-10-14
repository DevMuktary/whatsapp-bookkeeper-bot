import * as aiService from './services/aiService.js';
import * as accountingService from './services/accountingService.js';
import * as reportService from './services/reportService.js';
import * as whatsappService from './services/whatsappService.js';

function extractJsonFromString(str) {
    const jsonMatch = str.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try { return JSON.parse(jsonMatch[0]); } catch (error) { return null; }
}

export async function handleTaskStep(message, collections, user, conversation, isFirstStep = false, initialArgs = null) {
    const { conversationsCollection } = collections;
    const senderId = user.userId;
    const toolName = conversation.state.replace('collecting_', '').replace('_details', '');

    // If the router already gave us args (like format:'pdf'), we use them.
    if (initialArgs) {
        return executeTool(toolName, initialArgs, collections, senderId, user);
    }

    const messageForAI = isFirstStep ? `I want to ${toolName.replace(/([A-Z])/g, ' $1').toLowerCase()}` : message.text;
    const aiResponse = await aiService.processTaskMessage(messageForAI, toolName, collections, senderId);
    
    const collectedData = extractJsonFromString(aiResponse);

    if (collectedData) {
        return executeTool(toolName, collectedData, collections, senderId, user);
    } else {
        await whatsappService.sendMessage(senderId, aiResponse);
    }
}

async function executeTool(toolName, collectedData, collections, senderId, user) {
    const { conversationsCollection } = collections;
    let result;

    console.log(`Executing tool '${toolName}' with data:`, collectedData);

    // --- NEW SMART DISPATCH LOGIC ---
    if (toolName === 'generateInventoryReport') {
        if (collectedData.format === 'pdf') {
            result = await reportService.generateInventoryReport(collectedData, collections, senderId);
        } else {
            // Default to text if format is 'text' or not specified
            result = await accountingService.getInventory(collectedData, collections, senderId);
        }
    } else {
        // Find the correct service for other tools
        const executor = 
            accountingService[toolName] || 
            reportService[toolName];
        
        if (executor) {
            result = await executor(collectedData, collections, senderId);
        } else {
            console.error(`No executor found for tool: ${toolName}`);
            result = { message: "I'm sorry, I had an internal error trying to complete that task." };
        }
    }
    
    await whatsappService.sendMessage(senderId, result.message);

    await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'idle' } });
    
    setTimeout(() => {
        whatsappService.sendInteractiveMessage(senderId, "Is there anything else I can help with?", [
            { id: 'log_sale', title: 'Log a Sale' },
            { id: 'log_expense', title: 'Log an Expense' },
            { id: 'add_stock', title: 'Add New Stock' },
        ]);
    }, 1500);
}
