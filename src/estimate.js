import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";

import { regionName } from "./regions.js";
import { VERSION } from "./version.js";

export const SAVE_URL = "https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs";
export const READ_URL = "https://d3knqfixx3sbls.cloudfront.net";
export const PUBLIC_URL = "https://calculator.aws/#/estimate?id=";

export function buildServiceEntry({
  definition,
  template,
  region,
  result,
  description = null,
}) {
  const displayRegion = regionName(region) ?? region;
  return {
    calculationComponents: result.calculationComponents,
    serviceCode: definition.serviceCode,
    region,
    estimateFor: template.id,
    version: definition.version,
    description,
    serviceCost: {
      monthly: result.monthly,
      upfront: result.upfront,
    },
    serviceName: definition.serviceName?.trim() ?? definition.serviceCode,
    regionName: displayRegion,
    configSummary: result.summary,
  };
}

export function buildGroupServiceEntry({
  definition,
  region,
  subServices,
  description = null,
}) {
  const displayRegion = regionName(region) ?? region;
  const monthly = round2(
    subServices.reduce((acc, item) => acc + item.result.monthly, 0),
  );
  const upfront = round2(
    subServices.reduce((acc, item) => acc + item.result.upfront, 0),
  );
  const summary = subServices
    .map((item) => item.result.summary)
    .filter(Boolean)
    .join(", ");
  return {
    serviceCode: definition.serviceCode,
    region,
    estimateFor: definition.templateId,
    version: definition.version,
    description,
    subServices: subServices.map((item) => ({
      calculationComponents: item.result.calculationComponents,
      serviceCode: item.definition.serviceCode,
      region,
      estimateFor: item.template.id,
      version: item.definition.version,
      description: null,
      serviceCost: {
        monthly: item.result.monthly,
        upfront: item.result.upfront,
      },
    })),
    serviceCost: { monthly, upfront },
    serviceName: definition.serviceName,
    regionName: displayRegion,
    configSummary: summary,
  };
}

export function buildPayload({ name, services, currency = "USD" }) {
  const monthly = round2(
    services.reduce((acc, service) => acc + (service.serviceCost.monthly ?? 0), 0),
  );
  const upfront = round2(
    services.reduce((acc, service) => acc + (service.serviceCost.upfront ?? 0), 0),
  );
  const keyed = {};
  for (const service of services) {
    keyed[`${service.serviceCode}-${randomUUID()}`] = service;
  }
  return {
    name: name || "My Estimate",
    services: keyed,
    groups: {},
    groupSubtotal: { monthly, upfront },
    totalCost: { monthly, upfront },
    support: {},
    settings: {
      subTotalModifier: {
        type: "VOLUME_DISCOUNT",
        value: 0,
        valuePercentage: 0,
      },
    },
    metaData: {
      locale: "en_US",
      currency,
      createdOn: new Date().toISOString(),
      source: "calculator-platform",
    },
  };
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function saveEstimate(payload, { attempts = 3 } = {}) {
  const requestBody = JSON.stringify(payload);
  let response = null;
  let text = "";
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetch(SAVE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://calculator.aws",
          "user-agent": `awscalc/${VERSION}`,
        },
        body: requestBody,
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
      if (response.ok) break;
      if (response.status < 500) {
        throw new AxiError(
          `calculator.aws rejected the estimate (HTTP ${response.status})`,
          "UPSTREAM_ERROR",
          [summarizeUpstream(text)],
        );
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof AxiError) throw error;
      lastError = error;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  if (!response || !response.ok) {
    throw new AxiError(
      `Could not publish the estimate after ${attempts} attempts`,
      "UPSTREAM_ERROR",
      [
        summarizeUpstream(text) || lastError?.message || "calculator.aws did not respond",
        "Retry; if it keeps failing, split the estimate into fewer sub-services",
      ],
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AxiError(
      "calculator.aws returned an unexpected response",
      "UPSTREAM_ERROR",
    );
  }
  const inner =
    typeof body.body === "string" ? JSON.parse(body.body) : body.body ?? body;
  const key = inner?.savedKey ?? body.savedKey;
  if (!key) {
    throw new AxiError(
      "calculator.aws did not return an estimate key",
      "UPSTREAM_ERROR",
      [summarizeUpstream(text)],
    );
  }
  return { key, url: `${PUBLIC_URL}${key}` };
}

export function parseEstimateKey(value) {
  const input = String(value ?? "").trim();
  if (!input) return null;
  const urlMatch = input.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_-]{16,}$/.test(input)) return input;
  return null;
}

export async function readEstimate(key, { full = false } = {}) {
  const response = await fetch(`${READ_URL}/${encodeURIComponent(key)}`, {
    headers: {
      accept: "application/json",
      "user-agent": `awscalc/${VERSION}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    throw new AxiError(`No public estimate found for ${key}`, "NOT_FOUND", [
      "Check the URL or id; public estimates are immutable",
    ]);
  }
  if (!response.ok) {
    throw new AxiError(
      `Could not read estimate (HTTP ${response.status})`,
      "UPSTREAM_ERROR",
    );
  }
  const data = await response.json();
  const services = Object.values(data.services ?? {});
  const summary = {
    name: data.name,
    id: key,
    url: `${PUBLIC_URL}${key}`,
    monthly: round2(data.totalCost?.monthly ?? 0),
    upfront: round2(data.totalCost?.upfront ?? 0),
    total12Months: round2(
      (data.totalCost?.monthly ?? 0) * 12 + (data.totalCost?.upfront ?? 0),
    ),
    createdOn: data.metaData?.createdOn ?? null,
    services: services.map((service) => ({
      code: service.serviceCode,
      name: service.serviceName ?? service.serviceCode,
      region: service.regionName ?? service.region,
      monthly: round2(service.serviceCost?.monthly ?? 0),
      upfront: round2(service.serviceCost?.upfront ?? 0),
      config: service.configSummary ?? "",
    })),
  };
  if (full) summary.raw = data;
  return summary;
}

function summarizeUpstream(text) {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}
