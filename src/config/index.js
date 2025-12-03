// A central place for all configuration.
const config = {
  port: process.env.PORT || 3000,
  mongoURI: process.env.MONGO_URI,
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY
  },
  // [NEW] OpenAI for Vision and Voice (Whisper)
  openai: {
    apiKey: process.env.OPENAI_API_KEY 
  },
  brevo: {
    apiKey: process.env.BREVO_API_KEY
  },
  // [NEW] Redis for Message Queues (BullMQ)
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Basic validation
if (!config.mongoURI || !config.whatsapp.token) {
  console.error("FATAL ERROR: Missing critical environment variables.");
  process.exit(1);
}

export default config;
