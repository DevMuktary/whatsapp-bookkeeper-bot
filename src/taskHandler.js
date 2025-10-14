import * as aiService from './services/aiService.js';
import * as accountingService from './services/accountingService.js';
import * as reportService from './services/reportService.js';
import * as whatsappService from './services/whatsappService.js';

function extractJsonFromString(str) {
    const jsonMatch = str.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try { return JSON.parse(jsonMatch[0]); } catch (error) { return null; }
}

const conversationalToolExecutors = {
    'addProduct': accountingService.addProduct,
    'logSale': accountingService.logSale,
    'logTransaction': accountingService.logTransaction,
    'generateSalesReport': reportService.generateSalesReport,
};

export async function handleTaskStep(message, collections, user, conversation, isFirstStep = false) {
    const { conversationsCollection } = collections;
    const senderId = user.userId;
    const toolName = conversation.state.replace('collecting_', '').replace('_details', '');

    const messageForAI = isFirstStep ? `I want to ${toolName.replace(/([A-Z])/g, ' $1').toLowerCase()}` : message.text;
    const aiResponse = await aiService.processTaskMessage(messageForAI, toolName, collections, senderId);
    
    const collectedData = extractJsonFromString(aiResponse);

    if (collectedData) {
        const executor = conversationalToolExecutors[toolName];
        if (executor) {
            console.log(`Executing conversational tool '${toolName}' with data:`, collectedData);
            const result = await executor(collectedData, collections, senderId);
            await whatsappService.sendMessage(senderId, result.message);
        } else {
            console.error(`No executor found for conversational tool: ${toolName}`);
            await whatsappService.sendMessage(senderId, "I'm sorry, an internal error occurred.");
        }

        await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'idle' } });
        
        setTimeout(() => {
             whatsappService.sendInteractiveMessage(senderId, "Is there anything else I can help with?", [
                { id: 'log_sale', title: 'Log a Sale' },
                { id: 'log_expense', title: 'Log an Expense' },
                { id: 'add_stock', title: 'Add New Stock' },
            ]);
        }, 1500);

    } else {
        await whatsappService.sendMessage(senderId, aiResponse);
    }
}
