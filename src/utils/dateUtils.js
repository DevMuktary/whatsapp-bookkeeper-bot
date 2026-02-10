// A utility for handling common date range calculations and specific AI-parsed ranges.

/**
 * Calculates the start and end dates for a given period string OR a specific range object.
 * @param {string | object} periodOrRange - Can be 'today', 'this_month' OR { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
 * @returns {{startDate: Date, endDate: Date}}
 */
export function getDateRange(periodOrRange) {
    const now = new Date();
    let startDate, endDate = new Date(now);

    // Case 1: Input is an Object with specific Start/End dates (from AI)
    // Example: { startDate: "2024-12-01", endDate: "2024-12-31" }
    if (periodOrRange && typeof periodOrRange === 'object' && periodOrRange.startDate && periodOrRange.endDate) {
        // [FIX] Force explicit parsing to avoid timezone shifts
        // We split by '-' to ensure we are constructing it in Local Time or UTC consistently
        startDate = new Date(periodOrRange.startDate);
        startDate.setHours(0, 0, 0, 0);

        endDate = new Date(periodOrRange.endDate);
        endDate.setHours(23, 59, 59, 999);

        return { startDate, endDate };
    }

    // Set endDate to the very end of the current day (default for switch cases)
    endDate.setHours(23, 59, 59, 999);

    // Case 2: Input is a predefined keyword string
    switch (periodOrRange) {
        case 'today':
            startDate = new Date(now);
            startDate.setHours(0, 0, 0, 0);
            break;

        case 'this_week':
            startDate = new Date(now);
            const dayOfWeek = startDate.getDay(); // Sunday = 0, Monday = 1, ...
            const diff = startDate.getDate() - dayOfWeek;
            startDate = new Date(startDate.setDate(diff));
            startDate.setHours(0, 0, 0, 0);
            break;

        case 'this_month':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            startDate.setHours(0, 0, 0, 0);
            break;
            
        case 'last_month':
            const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            startDate = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0);
            endDate.setHours(23, 59, 59, 999);
            break;

        case 'this_year':
            startDate = new Date(now.getFullYear(), 0, 1);
            startDate.setHours(0, 0, 0, 0);
            break;

        default:
            // Default to 'this_month' if unrecognized
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            startDate.setHours(0, 0, 0, 0);
            break;
    }

    return { startDate, endDate };
}
