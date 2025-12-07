import IORedis from 'ioredis';
import config from '../config/index.js';
import logger from '../utils/logger.js';

// Create a single instance
const redis = new IORedis(config.redis.url, {
    ...config.redis.options,
    // Recommended defaults for stability
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

redis.on('error', (err) => {
    // Only log, don't crash. Redis will auto-reconnect.
    logger.error('Redis Client Error:', err);
});

redis.on('connect', () => {
    logger.info('Redis Client Connected Successfully.');
});

export default redis;
