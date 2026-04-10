import { describe, it, expect, vi } from 'vitest';
import { formatDateTime, getTimezones } from '../utils/time';

describe('time utils', () => {
  const testDate = '2026-04-10T15:30:45Z'; // UTC

  describe('formatDateTime', () => {
    it('returns em-dash for null date', () => {
      expect(formatDateTime(null)).toBe('—');
    });

    it('returns em-dash for invalid date', () => {
      expect(formatDateTime('invalid-date')).toBe('—');
    });

    it('formats with default settings (YYYY-MM-DD HH:mm:ss UTC)', () => {
      const result = formatDateTime(testDate);
      expect(result).toBe('2026-04-10 15:30:45');
    });

    it('formats with DD/MM/YYYY format', () => {
      const result = formatDateTime(testDate, {
        display_date_format: 'DD/MM/YYYY',
        display_time_format: 'HH:mm:ss',
        display_timezone: 'UTC',
      });
      expect(result).toBe('10/04/2026 15:30:45');
    });

    it('formats with MM/DD/YYYY format', () => {
      const result = formatDateTime(testDate, {
        display_date_format: 'MM/DD/YYYY',
        display_time_format: 'HH:mm:ss',
        display_timezone: 'UTC',
      });
      expect(result).toBe('04/10/2026 15:30:45');
    });

    it('formats with DD-MM-YYYY format', () => {
      const result = formatDateTime(testDate, {
        display_date_format: 'DD-MM-YYYY',
        display_time_format: 'HH:mm:ss',
        display_timezone: 'UTC',
      });
      expect(result).toBe('10-04-2026 15:30:45');
    });

    it('formats with 12h time (hh:mm:ss A)', () => {
      const result = formatDateTime(testDate, {
        display_date_format: 'YYYY-MM-DD',
        display_time_format: 'hh:mm:ss A',
        display_timezone: 'UTC',
      });
      expect(result).toMatch(/2026-04-10 03:30:45 (PM|pm)/);
    });

    it('formats without seconds (HH:mm)', () => {
      const result = formatDateTime(testDate, {
        display_date_format: 'YYYY-MM-DD',
        display_time_format: 'HH:mm',
        display_timezone: 'UTC',
      });
      expect(result).toBe('2026-04-10 15:30');
    });

    it('handles different timezones (New York)', () => {
      const result = formatDateTime(testDate, {
        display_date_format: 'YYYY-MM-DD',
        display_time_format: 'HH:mm:ss',
        display_timezone: 'America/New_York',
      });
      // 15:30 UTC is 11:30 EDT (UTC-4 in April)
      expect(result).toBe('2026-04-10 11:30:45');
    });

    it('falls back to ISO string on Intl error', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Invalid timezone should trigger error
      const result = formatDateTime(testDate, {
        display_date_format: 'YYYY-MM-DD',
        display_time_format: 'HH:mm:ss',
        display_timezone: 'Invalid/Timezone',
      });
      expect(result).toBe(new Date(testDate).toISOString());
      spy.mockRestore();
    });
  });

  describe('getTimezones', () => {
    it('returns a list of timezones', () => {
      const tzs = getTimezones();
      expect(Array.isArray(tzs)).toBe(true);
      expect(tzs.length).toBeGreaterThan(0);
      // Basic check that it contains some standard strings, without being environment-dependent
      expect(typeof tzs[0]).toBe('string');
    });

    it('falls back to UTC if supportedValuesOf fails', () => {
      const original = (Intl as any).supportedValuesOf;
      (Intl as any).supportedValuesOf = undefined;
      expect(getTimezones()).toEqual(['UTC']);
      (Intl as any).supportedValuesOf = original;
    });
  });
});
