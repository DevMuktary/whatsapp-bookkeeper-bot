// A utility for handling common date range calculations.

/**
 * Calculates the start and end dates for a given period string.
 * @param {string} period - e.g., 'today', 'this_week', 'this_month'
 * @returns {{startDate: Date, endDate: Date}}
 */
export function getDateRange(period) {
    const now = new Date();
    let startDate, endDate = new Date(now);

    // Set endDate to the very end of the current day
    endDate.setHours(23, 59, 59, 999);

    switch (period) {
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

        default:
            // Default to today if period is unrecognized
            startDate = new Date(now);
            startDate.setHours(0, 0, 0, 0);
            break;
    }

    return { startDate, endDate };
}
