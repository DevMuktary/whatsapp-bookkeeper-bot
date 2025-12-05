import winston from 'winston';
import config from '../config/index.js';

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }), // Capture stack traces
    winston.format.json() // Structured JSON output
);

const logger = winston.createLogger({
    level: config.logLevel || 'info',
    format: logFormat,
    defaultMeta: { service: 'fynax-bookkeeper' }, // Adds this label to every log
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(), // Colors for console readability
                winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
                    // Custom pretty print for local development
                    const metaString = Object.keys(meta).length ? JSON.stringify(meta) : '';
                    return `${timestamp} [${level}]: ${message} ${metaString} ${stack || ''}`;
                })
            )
        })
    ],
});

export default logger;
