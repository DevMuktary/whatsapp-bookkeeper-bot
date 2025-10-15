import { findOrCreateUser, updateUserState } from '../db/userService.js';
import { USER_STATES, INTENTS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { executeTask } from './taskHandler.js';
import { sendTextMessage } from '../api/whatsappService.js';

export async function handleInteractiveMessage(message) {
    const whatsappId = message.from;
    const interactiveData = message.interactive;

    try {
        const user = await findOrCreateUser(whatsappId);

        // We only care about button clicks for now
        if (interactiveData.type !== 'button_reply') {
            return;
        }
        
        const buttonId = interactiveData.button_reply.id;

        switch (user.state) {
            case USER_STATES.AWAITING_BULK_PRODUCT_CONFIRMATION:
                await handleBulkProductConfirmation(user, buttonId);
                break;
            
            // Add other cases for different states that use buttons later
            default:
                logger.warn(`Received a button click in an unhandled state: ${user.state} for user ${whatsappId}`);
                await sendTextMessage(whatsappId, "Sorry, I wasn't expecting that response right now.");
                break;
        }

    } catch (error) {
        logger.error(`Error in interactive handler for ${whatsappId}:`, error);
        await sendTextMessage(whatsappId, "Something went wrong while processing your selection. Please try again.");
    }
}

async function handleBulkProductConfirmation(user, buttonId) {
    if (buttonId === 'confirm_bulk_add') {
        const productsToAdd = user.stateContext.products;
        if (productsToAdd && productsToAdd.length > 0) {
            await sendTextMessage(user.whatsappId, "Great! Adding them to your inventory now... ⏳");
            // We pass the products stored in the context to the executor
            await executeTask(INTENTS.ADD_MULTIPLE_PRODUCTS, user, { products: productsToAdd });
        } else {
            await sendTextMessage(user.whatsappId, "Something went wrong, I seem to have lost the list of products. Please send it again.");
            await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
        }
    } else if (buttonId === 'cancel_bulk_add') {
        await sendTextMessage(user.whatsappId, "Okay, I've cancelled that request. You can try again or add products one by one.");
        await updateUserState(user.whatsappId, USER_STATES.IDLE, {});
    }
}
