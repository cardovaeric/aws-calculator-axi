import { AxiError } from "axi-sdk-js";

import { fetchJson } from "./http.js";
import { regionName } from "./regions.js";

const PRICING_BASE = "https://calculator.aws/pricing/2.0/meteredUnitMaps";

export const EC2_OS_LABELS = {
  linux: "Linux",
  windows: "Windows",
  rhel: "RHEL",
  "rhel-ha": "Red Hat Enterprise Linux with HA",
  suse: "SUSE",
  "ubuntu-pro": "Ubuntu Pro",
};

export const EC2_TENANCY_LABELS = {
  shared: "Shared",
  dedicated: "Dedicated",
  host: "Host",
};

const OS_SELECTIONS = {
  linux: ["Linux", "NA"],
  windows: ["Windows", "NA"],
  "windows-std": ["Windows", "SQL Std"],
  "windows-web": ["Windows", "SQL Web"],
  "windows-enterprise": ["Windows", "SQL Ent"],
  rhel: ["RHEL", "NA"],
  "rhel-ha": ["Red Hat Enterprise Linux with HA", "NA"],
  "rhel-web": ["RHEL", "SQL Web"],
  "rhel-std": ["RHEL", "SQL Std"],
  "rhel-enterprise": ["RHEL", "SQL Ent"],
  "rhel-ha-std": ["Red Hat Enterprise Linux with HA", "SQL Std"],
  "rhel-ha-enterprise": ["Red Hat Enterprise Linux with HA", "SQL Ent"],
  "linux-std": ["Linux", "SQL Std"],
  "linux-web": ["Linux", "SQL Web"],
  "linux-enterprise": ["Linux", "SQL Ent"],
  suse: ["SUSE", "NA"],
  "ubuntu-pro": ["Ubuntu Pro", "NA"],
};

export function ec2OsSelection(id, label) {
  const selection = OS_SELECTIONS[id];
  if (selection) return { os: selection[0], preInstalled: selection[1] };
  return { os: label ?? EC2_OS_LABELS[id] ?? String(id), preInstalled: "NA" };
}

export function loadEc2Context({ region, currency = "USD", ...fetchOptions }) {
  const display = regionName(region) ?? region;
  const base = `${PRICING_BASE}/ec2/${currency}/current/ec2-calc/${encodeURIComponent(
    display,
  )}`;
  return fetchJson(`${base}/primary-selector-aggregations.json`, fetchOptions).then(
    (aggregation) => ({ base, display, aggregation, currency }),
  );
}

function norm(value) {
  return String(value ?? "").toLowerCase();
}

function chooseLicense(matches, osLabel) {
  const available = [
    ...new Set(matches.map((entry) => entry.selectors?.["License Model"])),
  ].filter(Boolean);
  // The calculator bundles OS licenses into the "No License required" rate;
  // "License Included - Infrastructure" is the lower BYOL-style infrastructure rate.
  const prefer = [
    "No License required",
    "Bring your own license",
    "License Included - Infrastructure",
  ];
  return prefer.find((value) => available.includes(value)) ?? available[0];
}

/**
 * Pick the EC2 selector combination for an OS/tenancy/term. Instance type is
 * not part of the aggregation tables; it is looked up inside the index.
 */
export function selectEc2Aggregation(context, desired = {}) {
  const aggregations = context.aggregation?.aggregations ?? [];
  const osLabel = desired.os ?? "Linux";
  const tenancy = desired.tenancy ?? "Shared";
  const preInstalled = desired.preInstalled ?? "NA";
  const termType = desired.termType ?? "OnDemand";
  const lease = desired.lease ?? "";
  const purchase = desired.purchase ?? "";
  const offering = desired.offering ?? "";
  const generations = desired.currentGeneration
    ? [desired.currentGeneration]
    : ["Yes", "No"];

  for (const generation of generations) {
    const matches = aggregations.filter((entry) => {
      const s = entry.selectors ?? {};
      return (
        norm(s.Tenancy) === norm(tenancy) &&
        norm(s["Operating System"]) === norm(osLabel) &&
        norm(s["Pre Installed S/W"]) === norm(preInstalled) &&
        norm(s.TermType) === norm(termType) &&
        norm(s.LeaseContractLength) === norm(lease) &&
        norm(s.PurchaseOption) === norm(purchase) &&
        norm(s.OfferingClass) === norm(offering) &&
        norm(s["Current Generation"]) === norm(generation)
      );
    });
    if (matches.length === 0) continue;
    const license = chooseLicense(matches, osLabel);
    const hit =
      matches.find(
        (entry) => entry.selectors?.["License Model"] === license,
      ) ?? matches[0];
    return { aggregation: hit, generation, license };
  }

  throw new AxiError(
    `Amazon EC2 does not offer ${osLabel} / ${tenancy} in ${context.display}`,
    "VALIDATION_ERROR",
    [
      "Try another --region, OS, or tenancy",
      `Operating systems: ${[
        ...new Set(aggregations.map((entry) => entry.selectors?.["Operating System"])),
      ]
        .filter(Boolean)
        .join(", ")}`,
    ],
  );
}

export async function loadEc2Index(context, aggregation, fetchOptions = {}) {
  const s = aggregation.selectors ?? {};
  const values = [
    s.TermType ?? "",
    s.Tenancy ?? "",
    s["Operating System"] ?? "",
    s["Pre Installed S/W"] ?? "",
    s["License Model"] ?? "",
  ];
  for (const optional of [
    s.LeaseContractLength,
    s.PurchaseOption,
    s.OfferingClass,
  ]) {
    if (optional) values.push(optional);
  }
  values.push(s["Current Generation"] ?? "");
  const url = `${context.base}/${values
    .map((value) => encodeURIComponent(value))
    .join("/")}/index.json`;
  const data = await fetchJson(url, fetchOptions);
  return { url, data };
}

export function ec2Entries(index, display) {
  const region =
    index?.regions?.[display] ?? Object.values(index?.regions ?? {})[0] ?? {};
  return Object.values(region).filter(
    (entry) => entry && typeof entry === "object",
  );
}

export function findEc2Instance(index, display, instanceType) {
  const entry = ec2Entries(index, display).find(
    (item) => item["Instance Type"] === instanceType,
  );
  if (!entry) {
    throw new AxiError(
      `Instance type ${instanceType} is not available in ${display}`,
      "VALIDATION_ERROR",
      [
        "Instance availability differs by region and OS",
        "Run `awscalc service ec2`, then pick an instance shown in that region",
      ],
    );
  }
  return entry;
}

export function cheapestEc2Instance(index, display) {
  const entries = ec2Entries(index, display).filter(
    (entry) => Number(entry.price) > 0,
  );
  if (entries.length === 0) {
    throw new AxiError(
      `No EC2 instance prices are available in ${display}`,
      "UPSTREAM_ERROR",
    );
  }
  return entries.reduce((best, entry) =>
    Number(entry.price) < Number(best.price) ? entry : best,
  );
}

/**
 * Savings Plan effective hourly rates: the calculator publishes them in a
 * separate artifact keyed by instance type / region / OS / tenancy.
 */
export async function loadEc2SavingsIndex(
  context,
  { kind, term, purchaseOption, os, preInstalled = "NA", tenancy = "Shared" },
  fetchOptions = {},
) {
  const source = kind === "instance-savings" ? "instance-ec2-calc" : "compute-ec2-calc";
  const path = [
    context.display,
    tenancy,
    os,
    preInstalled,
    String(term),
    purchaseOption,
  ]
    .map((value) => encodeURIComponent(value))
    .join("/");
  const url = `${PRICING_BASE}/computesavingsplan/${
    context.currency ?? "USD"
  }/current/${source}/${path}/index.json`;
  try {
    return await fetchJson(url, fetchOptions);
  } catch {
    return null;
  }
}

export function extractEc2SavingsRate(
  index,
  display,
  { kind, term, purchaseOption, instanceType },
) {
  if (!index) return null;
  const region =
    index?.regions?.[display] ?? Object.values(index?.regions ?? {})[0] ?? {};
  const label =
    kind === "instance-savings"
      ? "EC2InstanceSavingsPlans"
      : "ComputeSavingsPlans";
  const key = `${label} ${instanceType} ${term} year ${purchaseOption}`;
  const hit = region[key];
  if (!hit) return null;
  const rate = Number(hit.price);
  return Number.isFinite(rate) ? rate : null;
}
