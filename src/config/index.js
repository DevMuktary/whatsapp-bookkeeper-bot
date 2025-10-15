// A central place for all configuration.
// Reads from environment variables provided by the deployment platform (e.g., Railway).

const config = {
  port: process.env.PORT,
  mongoURI: process.env.MONGO_URI,
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN // A secret token for webhook verification
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY
  },
  brevo: {
    apiKey: process.env.BREVO_API_KEY
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Basic validation to ensure critical variables are set
if (!config.mongoURI || !config.whatsapp.token || !config.whatsapp.verifyToken) {
  console.error("FATAL ERROR: Missing critical environment variables. Check MONGO_URI, WHATSAPP_TOKEN, and WHATSAPP_VERIFY_TOKEN.");
  process.exit(1);
}

export default config;
