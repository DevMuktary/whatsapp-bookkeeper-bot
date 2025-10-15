import config from '../config/index.js';

// A simple logger utility.
const logger = {
  info: (...args) => {
    if (config.logLevel === 'info' || config.logLevel === 'debug') {
      console.log('[INFO]', ...args);
    }
  },
  warn: (...args) => {
    if (config.logLevel !== 'error') {
      console.warn('[WARN]', ...args);
    }
  },
  error: (...args) => {
    console.error('[ERROR]', ...args);
  },
  debug: (...args) => {
    if (config.logLevel === 'debug') {
      console.debug('[DEBUG]', ...args);
    }
  },
};

export default logger;
