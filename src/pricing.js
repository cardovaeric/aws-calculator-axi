import { AxiError } from "axi-sdk-js";

import { fetchJson } from "./http.js";
import { parentRegion, regionName } from "./regions.js";

const PRICING_BASE = "https://calculator.aws/";

function resolveUrl(path, currency) {
  const withCurrency = String(path).replace(/\[currency\]/gi, currency);
  return new URL(withCurrency, PRICING_BASE).toString();
}

export function mappingDefinitionsFor(definition, template) {
  const all = [
    ...(definition?.mappingDefinitions ?? []),
    ...(template?.mappingDefinitions ?? []),
  ];
  const seen = new Set();
  return all.filter((mapping) => {
    if (!mapping?.mappingDefinitionURL) return false;
    if (seen.has(mapping.mappingDefinitionURL)) return false;
    seen.add(mapping.mappingDefinitionURL);
    return true;
  });
}

/**
 * Load every pricing map a definition needs and index it by metered-unit name.
 *
 * @returns {Promise<{maps: Map<string, object>, warnings: string[]}>}
 */
export async function loadPricingMaps(
  mappingDefinitions,
  { region, currency = "USD", ...fetchOptions } = {},
) {
  const display = regionName(region) ?? region;
  const parent = parentRegion(region);
  const parentDisplay = parent ? regionName(parent) : null;
  const maps = new Map();
  const warnings = [];
  const unsupportedMappings = new Set();

  await Promise.all(
    mappingDefinitions.map(async (mapping) => {
      if (mapping.mappingDefinitionVersion === "PLC_2.0") {
        // PLC mappings are queried by the columnFormIPM/PLC engine instead of
        // being merged into a metered-unit map. Track them so components that
        // reference one directly fail loudly.
        unsupportedMappings.add(mapping.mappingDefinitionName);
        return;
      }
      const url = resolveUrl(mapping.mappingDefinitionURL, currency);
      let data;
      try {
        data = await fetchJson(url, fetchOptions);
      } catch (error) {
        warnings.push(
          `Could not load pricing map ${mapping.mappingDefinitionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }

      let pricingData;
      let availableRegions = null;
      if (data?.prices && mapping.mappingDefinitionVersion) {
        // Legacy v1 maps place the price table under `prices`.
        pricingData = data.prices?.[display] ?? data.prices;
      } else if (data?.regions) {
        availableRegions = Object.keys(data.regions);
        // A calculator pricing map can hold region-less units in a "" (or
        // "Any") bucket that applies everywhere; the UI merges those in. The
        // selected region then overrides collisions.
        const nonRegional = {};
        for (const key of ["", "Any", "Global", "All other regions"]) {
          if (data.regions[key]) Object.assign(nonRegional, data.regions[key]);
        }
        // Local/Wavelength zones often reuse their parent region's prices.
        const parentPrices = parentDisplay
          ? data.regions[parentDisplay]
          : undefined;
        pricingData = {
          ...nonRegional,
          ...(parentPrices ?? {}),
          ...(data.regions[display] ?? {}),
        };
        if (Object.keys(pricingData).length === 0) pricingData = undefined;
      }

      if (!pricingData) {
        warnings.push(
          `${mapping.mappingDefinitionName}: pricing is unavailable for ${display}`,
        );
        return;
      }

      const units = new Set(Object.keys(pricingData));
      maps.set(mapping.mappingDefinitionName, {
        name: mapping.mappingDefinitionName,
        currency,
        region: display,
        availableRegions,
        units,
        data: pricingData,
        raw: data,
        priceFor(unit) {
          if (!unit) return null;
          const entry = this.data[unit];
          if (entry == null) return null;
          if (typeof entry === "number") return entry;
          if (typeof entry === "string") return Number(entry) || 0;
          if (typeof entry.price === "number") return entry.price;
          if (typeof entry.price === "string") return Number(entry.price);
          return null;
        },
        entryFor(unit) {
          return unit ? this.data[unit] : undefined;
        },
      });
    }),
  );

  return { maps, warnings, unsupportedMappings };
}

export function assertSupportedMappings(maps, warnings = []) {
  if (maps.size === 0) {
    throw new AxiError(
      "No usable pricing data for this service in the selected region",
      "UPSTREAM_ERROR",
      [
        ...warnings.slice(0, 3),
        "Try another --region",
        "Some services use advanced (PLC 2.0) pricing data that awscalc does not support yet",
      ],
    );
  }
}
