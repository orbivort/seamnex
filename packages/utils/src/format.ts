const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Formatting is configuration, not an ambient default.
 *
 * The platform stores UTC instants; rendering them in the browser's local zone made the
 * same timestamp read differently per operator. The default is therefore an explicit
 * locale and UTC, and a deployment can inject its own without touching call sites.
 */
export type FormattingConfig = { locale: string; timeZone: string };

export const DEFAULT_FORMATTING: FormattingConfig = { locale: 'en-GB', timeZone: 'UTC' };

let config: FormattingConfig = { ...DEFAULT_FORMATTING };
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function configureFormatting(next: Partial<FormattingConfig>): void {
  config = { ...config, ...next };
  dateTimeFormatters.clear();
  dateFormatters.clear();
}

export function formattingConfig(): Readonly<FormattingConfig> {
  return config;
}

function dateTimeFormatter(): Intl.DateTimeFormat {
  const key = `${config.locale}|${config.timeZone}`;
  const cached = dateTimeFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(config.locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: config.timeZone,
  });
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

function dateFormatter(): Intl.DateTimeFormat {
  const key = `${config.locale}|${config.timeZone}`;
  const cached = dateFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(config.locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: config.timeZone,
  });
  dateFormatters.set(key, formatter);
  return formatter;
}

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : dateTimeFormatter().format(date);
}

export function formatDate(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : dateFormatter().format(date);
}

export function formatRelative(value: string | number | Date, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const deltaMs = date.getTime() - now.getTime();
  if (Number.isNaN(deltaMs)) return 'unknown';

  const abs = Math.abs(deltaMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const suffix = deltaMs < 0 ? 'ago' : 'from now';
  if (abs < minute) return deltaMs < 0 ? 'just now' : 'in a moment';
  if (abs < hour) return `${Math.round(abs / minute)} min ${suffix}`;
  if (abs < day) return `${Math.round(abs / hour)} h ${suffix}`;
  if (abs < 30 * day) return `${Math.round(abs / day)} d ${suffix}`;
  return formatDate(date);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const precision = value >= 100 || exponent === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${BYTE_UNITS[exponent]}`;
}

/**
 * A latency, in the unit that keeps its precision.
 *
 * Dividing a millisecond measurement by 1 000 and rounding to whole seconds prints `0 s` for a
 * 42 ms cycle — which is exactly what the sync evidence screen did, so the one number that proves
 * the five-minute target read as "no measurement". Sub-second values therefore keep their unit and
 * everything above is seconds, which is also the unit the target is stated in.
 */
export function formatLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${Math.round(milliseconds / 1_000)} s`;
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

export function formatPercent(value: number, precision = 0): string {
  return `${(value * 100).toFixed(precision)}%`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(config.locale).format(value);
}

export function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

export function truncateMiddle(value: string, head = 12, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
