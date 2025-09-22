/**
 * Normalizes a phone number to the format used in the DB (e.g., 234810...).
 * @param {string} phone - The input phone number (e.g., +234810..., 0810...)
 * @returns {string|null} - The normalized JID-like number or null if invalid.
 */
export function normalizePhone(phone) {
    if (!phone) return null;
    let normalized = phone.replace(/[^0-9]/g, ''); // Remove non-numeric chars

    if (normalized.startsWith('0')) {
        normalized = '234' + normalized.substring(1); // Assume 234 for local numbers
    }

    // Ensure it's a plausible length after normalization
    if (normalized.length < 10 || normalized.length > 15) {
        return null;
    }

    return `${normalized}@s.whatsapp.net`;
}
