/**
 * Parses a price string (e.g., "10k", "2.5m", "₦5,000") into a number.
 * @param {string|number} priceInput 
 * @returns {number} The parsed amount or NaN
 */
export const parsePrice = (priceInput) => {
    if (typeof priceInput === 'number') return priceInput;
    if (typeof priceInput !== 'string') return NaN;

    const cleaned = priceInput.replace(/₦|,/g, '').toLowerCase().trim();
    let multiplier = 1;
    let numericPart = cleaned;

    if (cleaned.endsWith('k')) {
        multiplier = 1000;
        numericPart = cleaned.slice(0, -1);
    } else if (cleaned.endsWith('m')) {
        multiplier = 1000000;
        numericPart = cleaned.slice(0, -1);
    }

    const value = parseFloat(numericPart);
    return isNaN(value) ? NaN : value * multiplier;
};

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
