/**
 * central utility for time formatting based on global system settings.
 */

export interface TimeSettings {
  display_timezone: string;
  display_time_format: string;
  display_date_format: string;
}

export function formatDateTime(
  date: string | number | Date | null,
  settings?: TimeSettings
): string {
  if (!date) return '—';
  
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';

  // Defaults if settings are missing
  const tz = settings?.display_timezone || 'UTC';
  
  // Map formats to Intl options
  // Date: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'DD-MM-YYYY'
  // Time: 'HH:mm:ss' | 'hh:mm:ss A' | 'HH:mm'

  const dateFmt = settings?.display_date_format || 'YYYY-MM-DD';
  const timeFmt = settings?.display_time_format || 'HH:mm:ss';

  const hour12 = timeFmt.includes('A');
  const showSeconds = timeFmt.includes('ss');

  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: showSeconds ? '2-digit' : undefined,
      hour12: hour12,
    });

    const parts = formatter.formatToParts(d);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

    // Build date string based on format
    let dateStr = '';
    switch (dateFmt) {
      case 'DD/MM/YYYY':
        dateStr = `${getPart('day')}/${getPart('month')}/${getPart('year')}`;
        break;
      case 'MM/DD/YYYY':
        dateStr = `${getPart('month')}/${getPart('day')}/${getPart('year')}`;
        break;
      case 'DD-MM-YYYY':
        dateStr = `${getPart('day')}-${getPart('month')}-${getPart('year')}`;
        break;
      case 'YYYY-MM-DD':
      default:
        dateStr = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
        break;
    }

    // Build time string based on format
    let timeStr = `${getPart('hour')}:${getPart('minute')}`;
    if (showSeconds) {
      timeStr += `:${getPart('second')}`;
    }
    if (hour12) {
      timeStr += ` ${getPart('dayPeriod')}`;
    }

    return `${dateStr} ${timeStr}`;
    
  } catch (e) {
    console.error('DateTime formatting error:', e);
    return d.toISOString();
  }
}

export function getTimezones(): string[] {
  try {
    return (Intl as any).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}
