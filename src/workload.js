import { AxiError } from "axi-sdk-js";

export const HOURS_IN_MONTH = 730;
export const TOTAL_MONTHS = 12;
export const HOURS_IN_DAY = 24;
export const HOURS_PER_WEEK = 168;
export const MINUTES_IN_HOUR = 60;
export const AVG_WEEKS_IN_MONTH = 4.345238095238095;
export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DAY_ALIASES = new Map(
  DAY_NAMES.map((day) => [day.toLowerCase(), day]),
);
for (const [alias, day] of [
  ["sun", "Sunday"],
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["tues", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["thur", "Thursday"],
  ["thurs", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
]) {
  DAY_ALIASES.set(alias, day);
}

function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function valueOf(entry) {
  if (entry && typeof entry === "object" && "value" in entry) {
    return asNumber(entry.value);
  }
  return asNumber(entry);
}

function normalizeWorkloadType(value) {
  const text = String(value ?? "consistent").toLowerCase();
  if (["consistent", "daily", "weekly", "monthly"].includes(text)) return text;
  throw new AxiError(`Unknown workload type "${value}"`, "VALIDATION_ERROR", [
    "Use consistent, daily, weekly, or monthly",
  ]);
}

export function normalizeSelectedDays(days) {
  if (days == null) return DAY_NAMES;
  const list = Array.isArray(days)
    ? days
    : typeof days === "object"
      ? Object.entries(days)
          .filter(([, value]) => value?.value ?? value)
          .map(([day]) => day)
      : String(days)
          .split(/[,|\s]+/)
          .filter(Boolean);
  const out = [];
  for (const raw of list) {
    const day = DAY_ALIASES.get(String(raw).trim().toLowerCase());
    if (!day) {
      throw new AxiError(`Unknown day "${raw}" in workload`, "VALIDATION_ERROR", [
        `Use any of: ${DAY_NAMES.join(", ")}`,
      ]);
    }
    if (!out.includes(day)) out.push(day);
  }
  return out.length > 0 ? out : DAY_NAMES;
}

/** Normalize the calculator's `workload` state into the shape the formulas need. */
export function normalizeWorkload(raw) {
  if (raw == null) return { workloadType: "consistent", data: "1" };
  if (typeof raw === "string" || typeof raw === "number") {
    return { workloadType: "consistent", data: String(raw) };
  }
  const workloadType = normalizeWorkloadType(raw.workloadType);
  if (workloadType === "consistent") {
    const data = raw.data ?? raw.instances ?? raw.count ?? "1";
    return { workloadType, data: String(data) };
  }
  if (workloadType === "daily") {
    const items = Array.isArray(raw.data) ? raw.data : [raw.data ?? raw];
    const data = items.map((item) => {
      const days = normalizeSelectedDays(item.days ?? raw.selectedDays);
      return {
        baseline: valueOf(item.baseline),
        peak: valueOf(item.peak),
        hours: valueOf(item.hours),
        minutes: valueOf(item.minutes),
        days,
      };
    });
    return { workloadType, data, selectedDays: data[0]?.days ?? DAY_NAMES };
  }
  const item = raw.data ?? raw;
  return {
    workloadType,
    data: {
      baseline: { value: valueOf(item.baseline ?? raw.baseline) },
      peak: { value: valueOf(item.peak ?? raw.peak) },
      days: { value: valueOf(item.days ?? raw.spikeDays ?? raw.days) },
      hours: { value: valueOf(item.hours ?? raw.spikeHours ?? raw.hours) },
      minutes: { value: valueOf(item.minutes ?? raw.spikeMinutes ?? raw.minutes) },
    },
  };
}

/**
 * Convert a compact set of CLI flags into the calculator workload state.
 * Supported keys: workload, workloadData, instances, baseline, peak,
 * spikeDays, spikeHours, spikeMinutes, workloadDays.
 */
export function workloadFromInputs(inputs = {}) {
  const explicit = inputs.workload ?? inputs.workloadData;
  if (explicit != null) {
    if (typeof explicit === "object") return normalizeWorkload(explicit);
    const text = String(explicit);
    if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try {
        return normalizeWorkload(JSON.parse(text));
      } catch (error) {
        throw new AxiError(
          `Could not parse workload JSON: ${error.message}`,
          "VALIDATION_ERROR",
        );
      }
    }
    return normalizeWorkload(text);
  }
  const type = normalizeWorkloadType(inputs.workloadSelection ?? "consistent");
  if (type === "consistent") {
    return normalizeWorkload({
      workloadType: type,
      data: inputs.instances ?? inputs.quantity ?? 1,
    });
  }
  if (type === "daily") {
    return normalizeWorkload({
      workloadType: type,
      selectedDays: inputs.workloadDays,
      data: {
        baseline: inputs.baseline,
        peak: inputs.peak,
        hours: inputs.spikeHours ?? inputs.hours,
        minutes: inputs.spikeMinutes ?? inputs.minutes,
      },
    });
  }
  return normalizeWorkload({
    workloadType: type,
    data: {
      baseline: inputs.baseline,
      peak: inputs.peak,
      days: inputs.spikeDays ?? inputs.days,
      hours: inputs.spikeHours ?? inputs.hours,
      minutes: inputs.spikeMinutes ?? inputs.minutes,
    },
  });
}

function groupByType(entries) {
  return entries.reduce(
    (acc, entry) => {
      const key =
        entry.type === "reserved"
          ? "reservedHours"
          : entry.type === "ondemand"
            ? "onDemandHours"
            : null;
      const countKey =
        entry.type === "reserved"
          ? "reservedCount"
          : entry.type === "ondemand"
            ? "ondemandCount"
            : null;
      if (key) acc[key] += entry.instanceHours;
      if (countKey) acc[countKey] += entry.count;
      return acc;
    },
    { reservedHours: 0, reservedCount: 0, onDemandHours: 0, ondemandCount: 0 },
  );
}

function dailyUtilization(workload, breakeven) {
  const byDay = Object.fromEntries(
    DAY_NAMES.map((day) => [
      day,
      {
        baseline: 0,
        peak: 0,
        totalHours: 0,
        totalInstance: 0,
        days: {},
      },
    ]),
  );
  let maxInstances = 0;
  for (const item of workload.data) {
    const days = normalizeSelectedDays(item.days);
    const hours = asNumber(item.hours) + asNumber(item.minutes) / MINUTES_IN_HOUR;
    const baseline = asNumber(item.baseline);
    const peak = asNumber(item.peak);
    const totalInstance = Math.max(peak, baseline);
    maxInstances = Math.max(maxInstances, totalInstance);
    for (const day of days) {
      byDay[day] = {
        baseline,
        peak,
        totalHours: hours,
        totalInstance,
        days: Object.fromEntries(days.map((name) => [name, { value: true }])),
      };
    }
  }
  const perDay = [];
  let reservedCount = 0;
  let ondemandCount = 0;
  let reservedHours = 0;
  let onDemandHours = 0;
  for (let instance = 1; instance <= maxInstances; instance += 1) {
    const row = { instance };
    let weekly = 0;
    for (const day of DAY_NAMES) {
      const value = byDay[day];
      let hours = 0;
      if (instance <= value.baseline) hours = HOURS_IN_DAY;
      else if (instance <= value.totalInstance) hours = value.totalHours;
      row[day] = hours;
      weekly += hours;
    }
    const monthly = Math.min(weekly * AVG_WEEKS_IN_MONTH, HOURS_IN_MONTH);
    row.totalHoursPerWeek = weekly;
    row.totalHoursPerMonth = monthly;
    if (monthly > 0) {
      const type = monthly > breakeven ? "reserved" : "ondemand";
      row.type = type;
      if (type === "reserved") {
        reservedHours += monthly;
        reservedCount += 1;
      } else {
        onDemandHours += monthly;
        ondemandCount += 1;
      }
    } else {
      row.type = "";
    }
    perDay.push(row);
  }
  return {
    utilization: { perDay, perMonth: perDay },
    reservedCount,
    ondemandCount,
    reservedHours,
    onDemandHours,
  };
}

function periodUtilization(workload, breakeven) {
  const data = workload.data ?? {};
  const baseline = valueOf(data.baseline);
  const peak = valueOf(data.peak);
  const days = valueOf(data.days);
  const hours = valueOf(data.hours);
  const minutes = valueOf(data.minutes);
  const duration = days * HOURS_IN_DAY + hours + minutes / MINUTES_IN_HOUR;
  const capped =
    workload.workloadType === "weekly"
      ? Math.min(Number.isFinite(duration) ? duration : 0, HOURS_PER_WEEK)
      : Math.min(Number.isFinite(duration) ? duration : 0, HOURS_IN_MONTH);
  const peakExtra = Math.max(peak - baseline, 0);
  const peakMonthly =
    workload.workloadType === "weekly"
      ? peakExtra * capped * AVG_WEEKS_IN_MONTH
      : peakExtra * capped;
  const baselineIsReserved = HOURS_IN_MONTH > breakeven;
  const peakIsReserved = peakMonthly > breakeven;
  const perMonth =
    workload.workloadType === "weekly"
      ? [
          {
            count: baseline,
            instanceHours: baseline * HOURS_IN_MONTH,
            type: baselineIsReserved ? "reserved" : "ondemand",
          },
          {
            count: peakExtra,
            instanceHours: peakMonthly,
            type: peakMonthly > 0 ? (peakIsReserved ? "reserved" : "ondemand") : "",
          },
        ]
      : [
          {
            count: baseline,
            instanceHours: baseline * HOURS_IN_MONTH,
            type: "reserved",
          },
          {
            count: peakExtra,
            instanceHours: peakMonthly,
            type: capped > breakeven ? "reserved" : "ondemand",
          },
        ];
  const totals = groupByType(perMonth);
  return { utilization: { perMonth }, ...totals };
}

/**
 * Mirror the calculator's workload classifier. `breakeven` is in hours per
 * month; a workload segment above it is cheaper on a commitment.
 */
export function classifyWorkload(rawWorkload, breakeven = 0) {
  const workload = normalizeWorkload(rawWorkload);
  if (workload.workloadType === "consistent") {
    const count = asNumber(workload.data);
    return {
      workloadType: workload.workloadType,
      reservedCount: count,
      ondemandCount: 0,
      reservedHours: count * HOURS_IN_MONTH,
      onDemandHours: 0,
      breakeven,
    };
  }
  if (workload.workloadType === "daily") {
    return { workloadType: workload.workloadType, ...dailyUtilization(workload, breakeven), breakeven };
  }
  return { workloadType: workload.workloadType, ...periodUtilization(workload, breakeven), breakeven };
}

export function totalWorkloadHours(rawWorkload, breakeven = 0) {
  const result = classifyWorkload(rawWorkload, breakeven);
  return result.reservedHours + result.onDemandHours;
}

export function consistentInstanceCount(rawWorkload) {
  const workload = normalizeWorkload(rawWorkload);
  if (workload.workloadType !== "consistent") return 1;
  const count = asNumber(workload.data);
  return count > 0 ? count : 1;
}

/** Hours in a commitment term, matching the calculator (365 days × 24 h). */
export function commitmentHours(years) {
  return Number(years) * 365 * 24;
}

/** Effective hourly rate after the upfront portion of a commitment. */
export function effectiveHourlyRate(termYears, commitmentRate, upfrontCost) {
  const hours = commitmentHours(termYears);
  if (!hours) return 0;
  return (Number(commitmentRate) * hours - Number(upfrontCost)) / hours;
}

/**
 * Breakeven point in hours per month for a commitment option.
 * upfront/monthly are for one instance; monthly = effectiveHourly × 730.
 */
export function breakevenHours({
  termYears,
  upfrontCost,
  monthlyCost,
  effectiveRate,
  onDemandRate,
}) {
  const months = Number(termYears) * TOTAL_MONTHS;
  const normalizedMonthly = Number(monthlyCost ?? effectiveRate * HOURS_IN_MONTH);
  const onDemandMonthly = Number(onDemandRate) * HOURS_IN_MONTH;
  if (!onDemandMonthly) return 0;
  const normalized = Number(upfrontCost) / months + normalizedMonthly;
  return (normalized / onDemandMonthly) * HOURS_IN_MONTH;
}

export function workloadSummary(rawWorkload) {
  const workload = normalizeWorkload(rawWorkload);
  const label = workload.workloadType[0].toUpperCase() + workload.workloadType.slice(1);
  if (workload.workloadType === "consistent") {
    return `Workload (${label}, Number of instances: ${workload.data})`;
  }
  if (workload.workloadType === "daily") {
    const parts = workload.data.map(
      (item) =>
        `(Workload days: ${item.days.join(", ")}, Baseline: ${item.baseline}, Peak: ${item.peak}, Duration of peak: ${item.hours} Hr ${item.minutes} Min)`,
    );
    return `Workload (${label}, ${parts.join("")})`;
  }
  const data = workload.data;
  return `Workload (${label}, Baseline: ${data.baseline.value}, Peak: ${data.peak.value}, Duration of peak: ${data.days.value} Day ${data.hours.value} Hr ${data.minutes.value} Min)`;
}
