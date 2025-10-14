import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { MongoDBChatMessageHistory } from "@langchain/mongodb";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";

// --- Main LLM Configuration ---
const llm = new ChatOpenAI({
    modelName: "deepseek-chat",
    temperature: 0.1,
    configuration: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
    },
});

// --- Onboarding & Currency AIs (Unchanged) ---
const onboardingSystemPrompt = `You are an onboarding assistant for 'Fynax Bookkeeper'. Your SOLE GOAL is to collect a business name and a valid email address from the user. - Be conversational and friendly. - You can ask for the details one at a time. - If the user provides an invalid email, ask them for a correct one. - Once you are confident that you have successfully collected BOTH a business name AND a valid email address, your FINAL response MUST BE ONLY a raw JSON object with the collected data. - The JSON object should look like this: {{\"businessName\": \"Example Inc.\", \"email\": \"user@example.com\"}} - DO NOT add any other text, greetings, or markdown formatting to the final JSON response. Just the raw JSON.`;
const onboardingPrompt = ChatPromptTemplate.fromMessages([["system", onboardingSystemPrompt], new MessagesPlaceholder("chat_history"), ["human", "{input}"]]);
const onboardingChain = onboardingPrompt.pipe(llm).pipe(new StringOutputParser());
export async function processOnboardingMessage(text, collections, senderId) { /* ... unchanged ... */ }
const currencySystemPrompt = `You are an expert currency identifier. Your only task is to identify the official 3-letter ISO 4217 currency code from the user's text. The user might provide the currency name (e.g., 'Naira', 'Dollars'), a symbol (e.g., '₦', '$'), or slang (e.g., 'bucks'). If you can confidently identify the currency, respond with ONLY the 3-letter code (e.g., NGN, USD, GHS). If you cannot identify a currency, respond with the single word: UNKNOWN.`;
const currencyPrompt = ChatPromptTemplate.fromMessages([["system", currencySystemPrompt], ["human", "{text}"]]);
const currencyChain = currencyPrompt.pipe(llm).pipe(new StringOutputParser());
export async function extractCurrency(text) { /* ... unchanged ... */ }
// Placeholder functions to keep the file structure consistent
processOnboardingMessage = async function(text, collections, senderId) {
    const history = new MongoDBChatMessageHistory({ collection: collections.conversationsCollection, sessionId: senderId });
    const aiResponse = await onboardingChain.invoke({ input: text, chat_history: await history.getMessages() });
    try { JSON.parse(aiResponse); } catch (e) { await history.addUserMessage(text); await history.addAIMessage(aiResponse); }
    return aiResponse;
};
extractCurrency = async function(text) {
    try {
        const result = await currencyChain.invoke({ text });
        if (result && result.trim().toUpperCase() !== 'UNKNOWN' && result.trim().length === 3) { return result.trim().toUpperCase(); }
        return null;
    } catch (error) { console.error("Error in extractCurrency:", error); return null; }
};

// --- Tool Schemas: The Single Source of Truth ---
export const toolSchemas = {
    'addProduct': {
        description: "Adds a new product to inventory.",
        args: { productName: "string", quantity: "number", costPrice: "number", sellingPrice: "number" }
    },
    'logSale': {
        description: "Logs a customer sale.",
        args: { productName: "string", unitsSold: "number", amount: "number", customerName: "string (optional)", date: "string (e.g., today)", saleType: "string (cash/credit)" }
    },
    'logTransaction': {
        description: "Logs a general business expense.",
        args: { expenseType: "string (e.g., transport)", amount: "number", date: "string (e.g., yesterday)", description: "string (optional)" }
    },
    'getInventory': {
        description: "Gets a simple text list of all products in inventory.",
        args: {} // No arguments needed
    },
    'generateInventoryReport': {
        description: "Generates a formal PDF document of the inventory.",
        args: {} // No arguments needed
    },
    'generateSalesReport': {
        description: "Generates a PDF report of sales for a specific period.",
        args: { timeFrame: "string (e.g., 'today', 'this week')" }
    }
};

// --- 1. The New, Simpler Router AI ---
const routerSystemPrompt = `You are an expert at classifying user intent. Based on the user's message, identify which of the following tools they want to use. Respond with ONLY the tool name.
Tools: ${Object.keys(toolSchemas).join(', ')}.
- If the user asks for a 'report' or 'pdf', choose the 'generate...' version of the tool.
- If the user asks a simple question like 'what's my stock', choose the simple 'get...' version.
- If the intent is unclear or just a greeting, respond with the single word: "NONE".

Examples:
User: add a new macbook
Response: addProduct
User: send me my inventory report
Response: generateInventoryReport
User: how many macbooks do I have?
Response: getInventory
User: hi
Response: NONE`;

export async function routeUserIntent(text) {
    const prompt = ChatPromptTemplate.fromMessages([["system", routerSystemPrompt], ["human", "{input}"]]);
    const chain = prompt.pipe(llm).pipe(new StringOutputParser());
    const toolName = (await chain.invoke({ input: text })).trim();

    if (toolSchemas[toolName]) {
        return { tool: toolName };
    }
    return { tool: null, responseText: "I'm sorry, I can only help with bookkeeping and reports. How can I assist?" };
}


// --- 2. The Worker AI (Unchanged) ---
const workerSystemPrompt = `You are a conversational data collection assistant. Your only goal is to have a natural conversation with a user to collect the information needed for a specific task. You will be told the task and the specific arguments you need to collect. - Ask for the details one by one in a friendly, conversational manner. - If the user provides multiple details at once, acknowledge them and only ask for what's still missing. - Once you are confident you have collected ALL the required arguments, your FINAL response MUST BE ONLY a raw JSON object containing the collected data. - DO NOT add any other text to the final JSON response. TASK: You need to collect the arguments for the '{toolName}' tool. ARGUMENTS TO COLLECT: {argsString}`;

export async function processTaskMessage(text, toolName, collections, senderId) {
    const schema = toolSchemas[toolName];
    if (!schema) throw new Error(`Unknown tool: ${toolName}`);
    
    const argsString = JSON.stringify(schema.args);
    const prompt = ChatPromptTemplate.fromMessages([["system", workerSystemPrompt], new MessagesPlaceholder("chat_history"), ["human", "{input}"]]);
    const chain = RunnableSequence.from([prompt, llm, new StringOutputParser()]);
    const history = new MongoDBChatMessageHistory({ collection: collections.conversationsCollection, sessionId: senderId });

    const aiResponse = await chain.invoke({
        toolName: toolName, argsString: argsString,
        input: text, chat_history: await history.getMessages()
    });

    try { JSON.parse(aiResponse); } catch (e) {
        await history.addUserMessage(text);
        await history.addAIMessage(aiResponse);
    }
    
    return aiResponse;
}
