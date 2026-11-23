// Unit conversion factors used by the AWS Pricing Calculator itself.
// Sizes are binary (1 GB = 1024 MB), frequency conversions are based on the
// calculator's 730-hour month.

export const SIZE_GB = {
  bytes: 1 / 1024 ** 3,
  kb: 1 / 1024 ** 2,
  mb: 1 / 1024,
  gb: 1,
  tb: 1024,
  pb: 1024 ** 2,
};

export const SIZE_LABEL = {
  bytes: "Bytes",
  kb: "KB",
  mb: "MB",
  gb: "GB",
  tb: "TB",
  pb: "PB",
};

// Value of one unit expressed in "per month" events.
export const FREQ_PER_MONTH = {
  perMillisecond: 2_628_000_000,
  perSecond: 2_628_000,
  perMinute: 43_800,
  perHour: 730,
  perDay: 730 / 24,
  perWeek: 730 / 168,
  perMonth: 1,
  thousandPerMonth: 1e3,
  hundredThousandPerMonth: 1e5,
  millionPerMonth: 1e6,
  billionPerMonth: 1e9,
  trillionPerMonth: 1e12,
};

export const FREQ_LABEL = {
  perMillisecond: "per millisecond",
  perSecond: "per second",
  perMinute: "per minute",
  perHour: "per hour",
  perDay: "per day",
  perWeek: "per week",
  perMonth: "per month",
  thousandPerMonth: "thousand per month",
  hundredThousandPerMonth: "hundred thousand per month",
  millionPerMonth: "million per month",
  billionPerMonth: "billion per month",
  trillionPerMonth: "trillion per month",
};

export const TIME_SECONDS = {
  ms: 0.001,
  millisecond: 0.001,
  milliseconds: 0.001,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  day: 86400,
  days: 86400,
  week: 604800,
  weeks: 604800,
  month: 2_628_000,
  months: 2_628_000,
  year: 31_536_000,
  years: 31_536_000,
};

export function convertSize(value, from, to) {
  if (value == null || from === to) return value;
  const fromFactor = SIZE_GB[from];
  const toFactor = SIZE_GB[to];
  if (!fromFactor || !toFactor) return value;
  return (value * fromFactor) / toFactor;
}

export function convertFrequency(value, from, to) {
  if (value == null || !from || !to || from === to) return value;
  const fromFactor = FREQ_PER_MONTH[from];
  const toFactor = FREQ_PER_MONTH[to];
  if (!fromFactor || !toFactor) return value;
  return (value * fromFactor) / toFactor;
}

export function convertDuration(value, from, to) {
  if (value == null || !from || !to || from === to) return value;
  const fromFactor = TIME_SECONDS[from] ?? 1;
  const toFactor = TIME_SECONDS[to] ?? 1;
  return (value * fromFactor) / toFactor;
}

export function roundHalfUp(value, decimalPlaces = 0) {
  if (!Number.isFinite(value)) return value;
  // The calculator stores maths results with Number(...).toFixed(dp), which
  // rounds based on the underlying binary float. Mirror that exactly instead of
  // applying a decimal-arithmetic half-up rule.
  return Number(value.toFixed(decimalPlaces));
}

export function ceilTo(value, decimalPlaces = 0) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimalPlaces;
  return Math.ceil(value * factor) / factor;
}

export function roundUpTo(value, factor = 1) {
  if (!Number.isFinite(value) || !factor) return value;
  return Math.ceil(value / factor) * factor;
}

export function roundDownTo(value, factor = 1) {
  if (!Number.isFinite(value) || !factor) return value;
  return Math.floor(value / factor) * factor;
}

export function formatNumber(value, maxDecimals = 6) {
  if (value == null || Number.isNaN(value)) return "";
  if (!Number.isFinite(value)) return String(value);
  const fixed = value.toFixed(maxDecimals);
  const trimmed = fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return trimmed === "-0" ? "0" : trimmed;
}

export function formatCost(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}
