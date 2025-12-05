import { parsePrice } from '../utils/helpers.js';

describe('Helper Functions', () => {
    test('parsePrice handles "k" suffix', () => {
        expect(parsePrice('50k')).toBe(50000);
        expect(parsePrice('1.5k')).toBe(1500);
    });

    test('parsePrice handles "m" suffix', () => {
        expect(parsePrice('2m')).toBe(2000000);
    });

    test('parsePrice handles currency symbols and commas', () => {
        expect(parsePrice('₦5,000')).toBe(5000);
        expect(parsePrice('10,000.00')).toBe(10000);
    });

    test('parsePrice handles plain numbers', () => {
        expect(parsePrice(500)).toBe(500);
        expect(parsePrice('500')).toBe(500);
    });

    test('parsePrice returns NaN for invalid input', () => {
        expect(parsePrice('invalid')).toBe(NaN);
    });
});
