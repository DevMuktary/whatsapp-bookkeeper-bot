/**
 * Handles the multi-step onboarding process for new users.
 * Returns 'true' if it handled the message and 'false' if onboarding is complete.
 */
export async function handleOnboarding(sock, messageText, collections, senderId, state) {
    const { usersCollection, conversationsCollection } = collections;

    try {
        switch (state) {
            case 'awaiting_store_name':
                await usersCollection.updateOne({ userId: senderId }, { $set: { storeName: messageText } });
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_currency' } });
                await sock.sendMessage(senderId, { text: `Great! Your store name is set to *${messageText}*.\n\nNow, please select your primary currency (e.g., NGN, USD, GHS, KES).` });
                return true; // Onboarding handled the message, stop here.

            case 'awaiting_currency':
                const currency = messageText.toUpperCase().trim();
                await usersCollection.updateOne({ userId: senderId }, { $set: { currency: currency } });
                await conversationsCollection.updateOne({ userId: senderId }, { $set: { state: 'awaiting_opening_balance' } });
                await sock.sendMessage(senderId, { text: `Perfect. Currency set to *${currency}*.\n\nTo set up your initial stock, you can now tell me about your products. For example:\n\n"My opening balance is 20 phone chargers that cost me 3000 and I sell for 5000"` });
                return true; // Onboarding handled the message, stop here.

            case 'awaiting_opening_balance':
                // This is the final step. Unset the state and let the message
                // fall through to the AI to be processed as the opening balance.
                await conversationsCollection.updateOne({ userId: senderId }, { $unset: { state: "" } });
                return false; // Onboarding is done, proceed to AI.
        }
    } catch (error) {
        console.error("Error in onboarding service:", error);
        // Send a message if something goes wrong
        await sock.sendMessage(senderId, { text: "Sorry, there was an error setting up your account. Please try again." });
        return true; // Stop processing
    }

    // Default case, should not be hit if state is set
    return false;
}
