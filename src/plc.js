import { AxiError } from "axi-sdk-js";

import { fetchJson } from "./http.js";
import { regionName } from "./regions.js";

const PRICING_BASE = "https://calculator.aws/";

/**
 * Metadata for a PLC 2.0 mapping. These mappings do not contain prices inline:
 * the calculator exposes a per-region aggregation file plus a price index per
 * selector combination.
 */
export async function loadPlcContext(
  mapping,
  { region, currency = "USD", ...fetchOptions } = {},
) {
  if (!mapping?.mappingDefinitionURL) {
    throw new AxiError(
      "Missing PLC pricing metadata URL",
      "UPSTREAM_ERROR",
    );
  }
  const metadataUrl = new URL(
    String(mapping.mappingDefinitionURL).replace(/\[currency\]/gi, currency),
    PRICING_BASE,
  ).toString();
  const meta = await fetchJson(metadataUrl, fetchOptions);
  const base = metadataUrl.replace(/\/metadata\.json$/, "");
  const display = regionName(region) ?? region;
  const aggregationUrl = `${base}/${encodeURIComponent(
    display,
  )}/primary-selector-aggregations.json`;
  let aggregation;
  try {
    aggregation = await fetchJson(aggregationUrl, fetchOptions);
  } catch {
    throw new AxiError(
      `Pricing for this service is not available in ${display}`,
      "VALIDATION_ERROR",
      [
        "The calculator does not publish prices for this service in that region",
        "Try another --region",
      ],
    );
  }
  return {
    mappingName: mapping.mappingDefinitionName,
    meta,
    aggregation,
    base,
    display,
  };
}

function availableValues(aggregations, selector) {
  return [
    ...new Set(
      aggregations
        .map((entry) => entry.selectors?.[selector])
        .filter((value) => value != null && value !== ""),
    ),
  ];
}

/** Pick the aggregation entry that matches the requested selectors. */
export function selectAggregation(context, desired = {}) {
  const aggregations = context.aggregation?.aggregations ?? [];
  const wanted = Object.fromEntries(
    Object.entries(desired).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
  const matches = aggregations.filter((entry) =>
    Object.entries(wanted).every(
      ([key, value]) => String(entry.selectors?.[key]) === String(value),
    ),
  );
  if (matches.length > 0) return matches[0];

  const hints = [];
  if (wanted["Instance Type"]) {
    const query = String(wanted["Instance Type"]).toLowerCase();
    const near = availableValues(aggregations, "Instance Type").filter(
      (value) => value.toLowerCase().includes(query),
    );
    if (near.length > 0) {
      hints.push(
        `Similar instance types: ${near.slice(0, 10).join(", ")}${
          near.length > 10 ? ", ..." : ""
        }`,
      );
    }
  }
  for (const selector of ["Deployment Option", "TermType", "PurchaseOption"]) {
    if (wanted[selector]) {
      const values = availableValues(aggregations, selector);
      if (values.length > 0) {
        hints.push(`${selector}: ${values.slice(0, 10).join(", ")}`);
      }
    }
  }
  throw new AxiError(
    `No calculator price matches ${JSON.stringify(wanted)} in ${context.display}`,
    "VALIDATION_ERROR",
    hints.length > 0
      ? hints
      : ["Run `awscalc service <code>` to inspect the selector values"],
  );
}

/** Fetch the price index for one selector combination. */
export async function loadPlcIndex(context, selectors, fetchOptions = {}) {
  const keys = [
    ...(context.meta.primarySelectors ?? []),
    ...(context.meta.secondarySelectors ?? []),
  ];
  if (!keys.includes("Location") && !keys.includes("From Location")) {
    keys.unshift("Location");
  }
  const values = keys.map((key) =>
    String(
      key === "Location" || key === "From Location"
        ? selectors[key] ?? context.display
        : selectors[key] ?? "",
    ),
  );
  const url = `${context.base}/${values
    .map((value) => encodeURIComponent(value))
    .join("/")}/index.json`;
  const data = await fetchJson(url, fetchOptions);
  return { url, data };
}

function normalizeTerm(term) {
  if (!term) return null;
  const text = String(term).toLowerCase();
  if (/^1|\b1\s*(?:yr|year)/.test(text)) return "1yr";
  if (/^3|\b3\s*(?:yr|year)/.test(text)) return "3yr";
  return String(term);
}

function normalizePurchaseOption(option) {
  if (!option) return null;
  const text = String(option).toLowerCase();
  if (text.includes("all")) return "All Upfront";
  if (text.includes("partial")) return "Partial Upfront";
  if (text.includes("no")) return "No Upfront";
  return String(option);
}

/**
 * Extract hourly and upfront prices from an index file for either an
 * on-demand or a reserved term/payment option.
 */
export function extractPrices(
  index,
  display,
  { termType = "OnDemand", term, purchaseOption, pricingUnitModel, calculationId } = {},
  rows,
) {
  const region =
    index?.regions?.[display] ?? Object.values(index?.regions ?? {})[0] ?? {};
  const entries = Object.values(region).filter(
    (entry) => entry && typeof entry === "object",
  );
  if (entries.length === 0) {
    throw new AxiError(
      `No price dimensions found for this configuration in ${display}`,
      "UNSUPPORTED_SERVICE",
    );
  }

  const onDemand = !termType || /ondemand|hourly/i.test(String(termType));
  let candidates;
  if (onDemand) {
    candidates = entries.filter(
      (entry) => entry.TermType == null || entry.TermType === "OnDemand",
    );
  } else {
    const termValue = normalizeTerm(term);
    const optionValue = normalizePurchaseOption(purchaseOption);
    candidates = entries.filter(
      (entry) =>
        (entry.LeaseContractLength == null ||
          !termValue ||
          entry.LeaseContractLength === termValue) &&
        (entry.PurchaseOption == null ||
          !optionValue ||
          entry.PurchaseOption === optionValue),
    );
  }

  let hourlyEntries = candidates.filter(
    (entry) =>
      /hour|hrs/i.test(String(entry.Unit ?? "")) &&
      (entry.TermType == null || entry.TermType === "OnDemand" || !onDemand),
  );
  if (hourlyEntries.length === 0) {
    hourlyEntries = candidates.filter((entry) => entry.Unit == null);
  }
  const upfrontEntries = candidates.filter((entry) =>
    /quantity/i.test(String(entry.Unit ?? "")),
  );
  const perUnitEntry = candidates.find(
    (entry) =>
      entry.Unit != null &&
      !/hour|hrs|quantity/i.test(String(entry.Unit)),
  );
  if (
    hourlyEntries.length === 0 &&
    upfrontEntries.length === 0 &&
    !perUnitEntry
  ) {
    throw new AxiError(
      `No ${onDemand ? "on-demand" : "reserved"} price found for this configuration in ${display}`,
      "UNSUPPORTED_SERVICE",
      [
        "This term/payment option may not be available for the selected configuration",
        ...(rows?.length
          ? [`Rows: ${rows.map((row) => row.label).join(", ")}`]
          : []),
      ],
    );
  }
  let hourly = Number(hourlyEntries[hourlyEntries.length - 1]?.price ?? 0);
  const upfront = Number(
    upfrontEntries[upfrontEntries.length - 1]?.price ?? 0,
  );
  let perUnit = Number(perUnitEntry?.price ?? 0) || 0;

  // Some tables expose a monthly per-unit rate instead of an hourly rate
  // (Direct Connect ports, WorkSpaces Core bundles).
  const hourlyOverride =
    pricingUnitModel?.riPricingTypes?.hourly?.[0]?.$overridePriceKeyWith;
  const countlyOverride =
    pricingUnitModel?.riPricingTypes?.countly?.[0]?.$overridePriceKeyWith;
  if (hourlyOverride) {
    const entry = candidates.find((item) => item[hourlyOverride] != null);
    if (entry) {
      const value = Number(entry[hourlyOverride]);
      if (Number.isFinite(value)) hourly = value;
    }
  }
  if (countlyOverride) {
    const entry = candidates.find((item) => item[countlyOverride] != null);
    if (entry) {
      const value = Number(entry[countlyOverride]);
      if (Number.isFinite(value)) perUnit = value;
    }
  }
  return {
    hourly: Number.isFinite(hourly) ? hourly : 0,
    upfront: Number.isFinite(upfront) ? upfront : 0,
    perUnit,
    entries,
  };
}

/** Backwards-compatible alias for on-demand-only extraction. */
export function extractOnDemandPrices(index, display, rows) {
  return extractPrices(index, display, { termType: "OnDemand" }, rows);
}
