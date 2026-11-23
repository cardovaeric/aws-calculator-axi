import { readFile } from "node:fs/promises";
import process from "node:process";

import { AxiError, exitCodeForError, runAxiCli } from "axi-sdk-js";

import {
  ALIASES,
  findService,
  loadDefinition,
  loadManifest,
  serviceRegions,
} from "./catalog.js";
import { Engine, selectTemplate, supportedSurface } from "./engine.js";
import {
  buildGroupServiceEntry,
  buildPayload,
  buildServiceEntry,
  parseEstimateKey,
  readEstimate,
  saveEstimate,
} from "./estimate.js";
import {
  assertSupportedMappings,
  loadPricingMaps,
  mappingDefinitionsFor,
} from "./pricing.js";
import { DEFAULT_REGION, REGION_NAMES, resolveRegion } from "./regions.js";
import { recentForCwd, recordEstimate, readHistory } from "./store.js";
import { VERSION } from "./version.js";

const DESCRIPTION =
  "Estimate AWS costs with live calculator.aws pricing and publish shareable estimate URLs";

const HOME_HELP = [
  "Run `awscalc services` to browse the AWS service catalog",
  "Run `awscalc service <code>` to inspect the inputs for a service",
  "Run `awscalc price --service lambda --region us-east-1 --set numberOfRequests=10000000 --set durationOfEachRequest=200 --set sizeOfMemoryAllocated=512MB` to price a configuration",
  "Add `--share` to publish a public calculator.aws URL",
];

const COMMAND_HELP = {
  services: `awscalc services — browse the AWS Pricing Calculator catalog

flags:
  --filter <text>   Only services whose code, name, or alias contains text
  --all             Include calculator sub-services (default: top-level services)
  --limit <n>       Maximum rows (default 60)
  --json            Raw JSON instead of TOON
  --refresh         Ignore the local catalog cache
  --offline         Use cached data only

examples:
  awscalc services --filter s3
  awscalc services --all --filter gateway
`,
  service: `awscalc service <code> — show templates and configurable inputs

flags:
  --template <id>   Template to inspect (default: first)
  --region <code>   Region used for availability checks (default ${DEFAULT_REGION})
  --limit <n>       Maximum inputs to list (default 120)
  --full            Include descriptions, units, and validation ranges
  --json            Raw JSON instead of TOON
  --refresh         Ignore the local definition cache
  --offline         Use cached data only

examples:
  awscalc service lambda
  awscalc service amazonCloudFront --full
`,
  regions: `awscalc regions — list AWS regions for a service

flags:
  --service <code>  Service code or alias (required)
  --json            Raw JSON instead of TOON

example:
  awscalc regions --service lambda
`,
  price: `awscalc price — compute a price and optionally publish a public estimate

flags:
  --service <code>     Service code or alias (required)
  --template <id>      Template within the service (default: first)
  --region <code>      AWS region code (default ${DEFAULT_REGION})
  --set <id=value>     Set an input; repeatable (values may include units)
  --subservice <code>  For grouped services (S3, DynamoDB, SNS, ...): select a
                       sub-service; repeatable (default: the calculator default)
  --input-json <path>  JSON object of input ids to values ("-" for stdin)
  --name <text>        Estimate name when publishing (default "<service> estimate")
  --description <text> Service description stored in the estimate
  --share              Publish to calculator.aws and return a public URL
  --explain            Include per-line calculation breakdown
  --json               Raw JSON instead of TOON
  --refresh            Ignore cached service definitions and prices
  --offline            Use cached data only
  --currency <code>    Currency (only USD is supported)

examples:
  awscalc price --service lambda --set numberOfRequests=10000000 --set durationOfEachRequest=200 --set sizeOfMemoryAllocated=512MB
  awscalc price --service amazonS3Standard --region eu-west-1 --set s3StandardStorageSize=5TB --set s3StandardGetRequests=2000000 --share
  awscalc price --service amazonCloudFront --input-json cloudfront.json --explain
`,
  get: `awscalc get <url|id> — read a published calculator.aws estimate

flags:
  --full             Include the raw stored estimate JSON
  --json             Raw JSON instead of TOON

examples:
  awscalc get https://calculator.aws/#/estimate?id=53095d74815624a0880feb42bb4fb6e258450942
  awscalc get 53095d74815624a0880feb42bb4fb6e258450942 --full
`,
};

const FLAG_SPECS = {
  services: {
    values: ["filter", "limit"],
    booleans: ["all", "json", "refresh", "offline"],
    repeated: [],
  },
  service: {
    values: ["template", "region", "limit"],
    booleans: ["full", "json", "refresh", "offline"],
    repeated: [],
  },
  regions: {
    values: ["service"],
    booleans: ["json", "refresh", "offline"],
    repeated: [],
  },
  price: {
    values: [
      "service",
      "template",
      "region",
      "name",
      "description",
      "input-json",
      "currency",
    ],
    booleans: ["share", "explain", "json", "refresh", "offline"],
    repeated: ["set", "subservice"],
  },
  get: {
    values: [],
    booleans: ["full", "json"],
    repeated: [],
  },
};

function validFlagList(command) {
  const spec = FLAG_SPECS[command];
  if (!spec) return "--help";
  return [
    ...spec.values.map((flag) => `--${flag}`),
    ...spec.booleans.map((flag) => `--${flag}`),
    ...spec.repeated.map((flag) => `--${flag}`),
    "--help",
  ].join(", ");
}

function parseFlags(command, args) {
  const spec = FLAG_SPECS[command];
  const flags = {};
  for (const repeated of spec.repeated) flags[repeated] = [];
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s);
    if (rawName === "help") {
      flags.help = true;
      continue;
    }
    if (spec.booleans.includes(rawName)) {
      flags[rawName] = inline === undefined ? true : inline !== "false";
      continue;
    }
    if (spec.values.includes(rawName) || spec.repeated.includes(rawName)) {
      const value = inline ?? args[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new AxiError(
          `Flag --${rawName} needs a value`,
          "VALIDATION_ERROR",
          [`Usage: ${COMMAND_HELP[command].split("\n")[0]}`],
        );
      }
      if (inline === undefined) index += 1;
      if (spec.repeated.includes(rawName)) flags[rawName].push(value);
      else flags[rawName] = value;
      continue;
    }
    const renamed = {
      status: "--state is not a flag; use --filter for services",
      id: "pass the estimate id as a positional argument",
      output: "use --name or --input-json instead",
    }[rawName];
    throw new AxiError(
      `unknown flag --${rawName} for \`${command}\``,
      "VALIDATION_ERROR",
      [
        renamed ?? `valid flags for \`${command}\`: ${validFlagList(command)}`,
        `Run \`awscalc ${command} --help\` for examples`,
      ],
    );
  }
  return { flags, positionals };
}

function assertNoPositionals(command, positionals) {
  if (positionals.length > 0) {
    throw new AxiError(
      `unexpected argument "${positionals[0]}" for \`${command}\``,
      "VALIDATION_ERROR",
      [`valid flags for \`${command}\`: ${validFlagList(command)}`],
    );
  }
}

function parseSetFlags(pairs) {
  const overrides = {};
  for (const pair of pairs ?? []) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      throw new AxiError(`--set expects id=value, received "${pair}"`, "VALIDATION_ERROR", [
        "Example: --set s3StandardStorageSize=5TB",
      ]);
    }
    overrides[pair.slice(0, index)] = { text: pair.slice(index + 1) };
  }
  return overrides;
}

async function readInputJson(path) {
  if (!path) return {};
  let text;
  if (path === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    text = await readFile(path, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AxiError(
      `Could not parse --input-json: ${error.message}`,
      "VALIDATION_ERROR",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AxiError("--input-json must be a JSON object", "VALIDATION_ERROR");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      { text: String(value) },
    ]),
  );
}

async function home() {
  const cwd = process.cwd();
  const entries = recentForCwd(await readHistory(), cwd);
  if (entries.length === 0) {
    return {
      recent: "no estimates saved from this directory yet",
      help: HOME_HELP,
    };
  }
  return {
    recent: entries.map((entry) => ({
      name: entry.name,
      service: entry.service,
      monthly: entry.monthly,
      url: entry.url,
    })),
    help: HOME_HELP,
  };
}

async function servicesCommand(args) {
  const { flags, positionals } = parseFlags("services", args);
  assertNoPositionals("services", positionals);
  const manifestOptions = {
    refresh: flags.refresh,
    offline: flags.offline,
  };
  const all = await loadManifest(manifestOptions);
  const limit = flags.limit ? Number(flags.limit) : 60;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new AxiError("--limit must be a positive number", "VALIDATION_ERROR");
  }
  const filter = String(flags.filter ?? "").trim().toLowerCase();
  const baseFiltered = all.filter((service) => {
    if (service.type === "static") return false;
    if (!filter) return true;
    return (
      service.code.toLowerCase().includes(filter) ||
      service.name.toLowerCase().includes(filter) ||
      Object.entries(ALIASES).some(
        ([alias, code]) =>
          code === service.code && alias.includes(filter),
      )
    );
  });
  const filtered = flags.all
    ? baseFiltered
    : baseFiltered.filter((service) => service.subType !== "subService");
  if (filtered.length === 0) {
    return {
      services: `0 services match "${flags.filter ?? ""}" in ${
        flags.all ? "the full catalog" : "top-level services"
      }`,
      help: [
        "Run `awscalc services` to list the catalog",
        "Try a broader --filter or add --all to include sub-services",
      ],
    };
  }
  const rows = filtered.slice(0, limit).map((service) => ({
    code: service.code,
    name: service.name,
    alias:
      Object.entries(ALIASES).find(([, code]) => code === service.code)?.[0] ??
      "-",
  }));
  const output = {
    count: `${rows.length} of ${filtered.length} services`,
    services: rows,
  };
  if (filtered.length > rows.length) {
    output.help = [
      `Run \`awscalc services --limit ${filtered.length}${
        flags.all ? " --all" : ""
      }\` for all ${filtered.length}`,
      filter
        ? `Run \`awscalc service <code>\` to inspect an input schema`
        : "Run `awscalc services --filter <text>` to narrow the catalog",
    ];
  } else if (rows.length === 0) {
    output.help = [
      `No services match "${flags.filter}"`,
      "Run `awscalc services` to list the catalog",
    ];
  } else {
    output.help = ["Run `awscalc service <code>` to inspect a service's inputs"];
  }
  if (!flags.all && baseFiltered.length > filtered.length) {
    output.help = [
      `Add \`--all\` to include ${baseFiltered.length - filtered.length} sub-services`,
      ...output.help,
    ];
  }
  return flags.json ? JSON.stringify(output, null, 2) : output;
}


async function resolveServiceAndDefinition(flags, options) {
  const service = await findService(flags.service, options);
  const definition = await loadDefinition(service, options);
  return { service, definition };
}

function inputDefaultText(component) {
  switch (component.subType) {
    case "dropdown": {
      const options = component.options ?? [];
      const id =
        component.defaultDropDownItem ??
        (typeof component.defaultOption === "string"
          ? component.defaultOption
          : undefined) ??
        options[0]?.id;
      return id ?? "-";
    }
    case "fileSize": {
      const size =
        component.defaultOption?.size ?? component.dropDownSize?.[0]?.id ?? "gb";
      const freq =
        component.defaultOption?.frequency ??
        component.dropDownFrequency?.[0]?.id ??
        "NA";
      const value = component.defaultValue ?? 0;
      return freq === "NA" ? `${value} ${size}` : `${value} ${size}/${freq}`;
    }
    case "frequency": {
      const unit = component.defaultFrequency ?? "perMonth";
      const label =
        component.options?.find(
          (option) => (option.value ?? option.id) === unit,
        )?.label ?? unit;
      return `${component.defaultValue ?? 0} ${label}`;
    }
    case "durationInput": {
      const unit =
        component.defaultDuration ??
        component.dropDownDuration?.[0]?.value ??
        component.outputDurationUnit;
      const label =
        component.dropDownDuration?.find(
          (option) => (option.value ?? option.id) === unit,
        )?.label ?? unit;
      return `${component.defaultValue ?? 0} ${label}`;
    }
    case "throughput":
      return `${component.defaultValue ?? 0} ${
        component.defaultThroughput ?? component.outputThroughput?.value ?? ""
      }`.trim();
    case "checkbox":
      return component.defaultValue ? "true" : "false";
    case "percentInput":
      return `${
        component.defaultValue === "" || component.defaultValue == null
          ? 0
          : component.defaultValue
      }%`;
    case "utilization":
      return `${component.defaultValue ?? 0} ${
        component.defaultDuration === "percentagePerMonth" ? "%" : "hours"
      }`;
    default:
      return component.defaultValue === "" || component.defaultValue == null
        ? "-"
        : String(component.defaultValue);
  }
}

async function serviceCommand(args) {
  const { flags, positionals } = parseFlags("service", args);
  if (positionals.length === 0) {
    throw new AxiError("service code is required", "VALIDATION_ERROR", [
      "Run `awscalc services` to list service codes",
      "Example: awscalc service lambda",
    ]);
  }
  if (positionals.length > 1) {
    assertNoPositionals("service", positionals.slice(1));
  }
  const region = resolveRegion(flags.region);
  if (!region) {
    throw new AxiError(`Unknown region: ${flags.region}`, "VALIDATION_ERROR", [
      `Run \`awscalc regions --service ${positionals[0]}\` for valid regions`,
    ]);
  }
  const options = { refresh: flags.refresh, offline: flags.offline };
  const { service, definition } = await resolveServiceAndDefinition(
    { service: positionals[0] },
    options,
  );
  if (definition.subType === "subServiceSelector") {
    const available = (definition.templates ?? []).filter(
      (item) => typeof item === "string",
    );
    const defaults = new Set(definition.defaultTemplates ?? []);
    const names = await loadServiceNameMap(options);
    const rows = available.map((code) => ({
      code,
      name: names.get(code) ?? code,
      default: defaults.has(code) ? "yes" : "-",
    }));
    return flags.json
      ? JSON.stringify(
          {
            service: {
              code: service.code,
              name: service.name,
              group: true,
              subServices: available.length,
            },
            subServices: rows,
          },
          null,
          2,
        )
      : {
          service: {
            code: service.code,
            name: service.name,
            group: true,
            subServices: available.length,
          },
          subServices: rows,
          help: [
            `Run \`awscalc price --service ${service.code} --subservice <code> --set <id>=<value>\``,
            "Repeat --subservice to combine several sub-services in one estimate",
            "Run `awscalc service <subservice-code>` to see that sub-service's inputs",
          ],
        };
  }
  const template = selectTemplate(definition, flags.template);
  const surface = supportedSurface({ ...definition, templates: [template] });
  const INPUT_DISPLAY_TYPES = new Set([
    "numericInput",
    "dropdown",
    "frequency",
    "fileSize",
    "durationInput",
    "percentInput",
    "throughput",
    "utilization",
    "checkbox",
  ]);
  const inputs = [];
  const seen = new Set();
  for (const card of template.cards ?? []) {
    for (const component of card.inputSection?.components ?? []) {
      if (
        component.type !== "input" ||
        !component.id ||
        seen.has(component.id) ||
        !INPUT_DISPLAY_TYPES.has(component.subType)
      ) {
        continue;
      }
      seen.add(component.id);
      const options = component.options ?? [];
      const values =
        component.subType === "dropdown"
          ? `${options
              .slice(0, flags.full ? options.length : 12)
              .map((option) => `${option.id}=${option.label}`)
              .join("|")}${options.length > 12 && !flags.full ? "|..." : ""}`
          : "-";
      const row = {
        id: component.id,
        type: component.subType,
        default: inputDefaultText(component),
        values,
      };
      if (flags.full) {
        row.required = component.validations?.required ? "yes" : "-";
        row.label = component.label ?? "";
        row.min = component.validations?.minValue ?? "-";
        row.max = component.validations?.maxValue ?? "-";
      }
      inputs.push(row);
    }
  }
  const limit = flags.limit ? Number(flags.limit) : 120;
  const rows = inputs.slice(0, limit);
  const output = {
    service: {
      code: service.code,
      name: service.name,
      template: template.title
        ? `${template.id} (${template.title})`
        : template.id,
      region,
      version: definition.version,
    },
    inputs: rows,
  };
  if (template.cards?.length) output.cards = template.cards.length;
  if (surface.unsupportedMath.length || surface.unsupportedPricing.length) {
    output.unsupported = [
      ...surface.unsupportedMath.map((item) => `maths:${item}`),
      ...surface.unsupportedPricing.map((item) => `pricing:${item}`),
      ...surface.unsupportedInput.map((item) => `input:${item}`),
    ];
  }
  const help = [];
  if ((definition.templates ?? []).filter((item) => item?.id).length > 1) {
    help.push(
      `Templates: ${definition.templates
        .filter((item) => item?.id)
        .map((item) => item.id)
        .join(", ")} — select with --template`,
    );
  }
  if (inputs.length > rows.length) {
    help.push(
      `Run \`awscalc service ${service.code} --limit ${inputs.length}\` for all ${inputs.length} inputs`,
    );
  }
  help.push(
    `Run \`awscalc price --service ${service.code} --set <id>=<value>\` to price a configuration`,
  );
  if (help.length) output.help = help;
  return flags.json ? JSON.stringify(output, null, 2) : output;
}

function inputIdsForTemplate(template) {
  const ids = new Set();
  for (const card of template?.cards ?? []) {
    for (const component of card.inputSection?.components ?? []) {
      if (component.type === "input" && component.id) ids.add(component.id);
    }
  }
  return ids;
}

async function loadServiceNameMap(options) {
  const manifest = await loadManifest(options);
  return new Map(manifest.map((service) => [service.code, service.name]));
}

async function regionsCommand(args) {
  const { flags, positionals } = parseFlags("regions", args);
  assertNoPositionals("regions", positionals);
  if (!flags.service) {
    throw new AxiError("--service is required", "VALIDATION_ERROR", [
      "Example: awscalc regions --service lambda",
    ]);
  }
  const options = { refresh: flags.refresh, offline: flags.offline };
  const { service, definition } = await resolveServiceAndDefinition(flags, options);
  const regions = serviceRegions(service, definition);
  const output = {
    service: service.code,
    count: regions.length,
    regions,
  };
  if (regions.length === 0) {
    output.regions = "no regions listed";
    output.help = ["This service is priced globally; any region code is accepted"];
  }
  return flags.json ? JSON.stringify(output, null, 2) : output;
}

async function priceCommand(args) {
  const { flags, positionals } = parseFlags("price", args);
  assertNoPositionals("price", positionals);
  if (!flags.service) {
    throw new AxiError("--service is required", "VALIDATION_ERROR", [
      "Run `awscalc services` to list service codes",
      "Example: awscalc price --service lambda --set numberOfRequests=1000000",
    ]);
  }
  const currency = String(flags.currency ?? "USD").toUpperCase();
  if (currency !== "USD") {
    throw new AxiError("Only USD is supported", "VALIDATION_ERROR", [
      "The calculator's public pricing maps are published in USD",
    ]);
  }
  const region = resolveRegion(flags.region);
  if (!region) {
    throw new AxiError(`Unknown region: ${flags.region}`, "VALIDATION_ERROR", [
      "Use an AWS region code such as us-east-1 or eu-west-1",
    ]);
  }
  const options = { refresh: flags.refresh, offline: flags.offline };
  const { service, definition } = await resolveServiceAndDefinition(flags, options);
  const overrides = {
    ...(await readInputJson(flags["input-json"])),
    ...parseSetFlags(flags.set),
  };
  if (definition.subType === "subServiceSelector") {
    return priceGroup({
      service,
      definition,
      flags,
      region,
      currency,
      overrides,
      options,
    });
  }
  return priceSingle({
    service,
    definition,
    flags,
    region,
    currency,
    overrides,
    options,
  });
}

async function priceSingle({
  service,
  definition,
  flags,
  region,
  currency,
  overrides,
  options,
}) {
  const template = selectTemplate(definition, flags.template);
  const {
    maps,
    warnings: mapWarnings,
    unsupportedMappings,
  } = await loadPricingMaps(
    mappingDefinitionsFor(definition, template),
    { region, currency, ...options },
  );
  assertSupportedMappings(maps, mapWarnings);

  const engine = new Engine({
    definition,
    template,
    region,
    displayRegion: REGION_NAMES[region] ?? region,
    maps,
    currency,
    unsupportedMappings,
  });
  const { unknown } = engine.resolveInputs(overrides);
  if (unknown.length > 0) {
    const known = validInputIds(engine);
    throw new AxiError(
      `Unknown input${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      "VALIDATION_ERROR",
      [
        `Run \`awscalc service ${service.code}\` to list input ids`,
        `First inputs: ${known.slice(0, 8).join(", ")}`,
      ],
    );
  }
  const result = engine.evaluate();
  const allWarnings = [...mapWarnings, ...result.warnings];

  const output = {
    service: service.name,
    code: service.code,
    template: template.id,
    region,
    regionName: REGION_NAMES[region] ?? region,
    monthly: result.monthly,
    upfront: result.upfront,
    total12Months: result.total12Months,
    currency,
    summary: result.summary || null,
  };
  if (flags.explain) {
    output.items = result.costLines.map((line) => ({
      card: line.card ?? "-",
      label: line.label,
      costType: line.costType,
      amount: line.amount,
    }));
    output.calculations = result.trace
      .filter((step) => !step.id.includes("_generated_"))
      .map((step) => ({
        id: step.id,
        value: step.value,
      }));
  }
  if (allWarnings.length > 0) output.warnings = allWarnings;

  if (flags.share) {
    const entry = buildServiceEntry({
      definition,
      template,
      region,
      result,
      description: flags.description ?? null,
    });
    const payload = buildPayload({
      name: flags.name ?? `${service.name} estimate`,
      services: [entry],
      currency,
    });
    const saved = await saveEstimate(payload);
    output.url = saved.url;
    await recordEstimate({
      name: payload.name,
      service: service.name,
      code: service.code,
      region,
      monthly: result.monthly,
      upfront: result.upfront,
      url: saved.url,
      key: saved.key,
      cwd: process.cwd(),
    });
  } else {
    output.help = [
      `Run the same command with \`--share\` to publish a public calculator.aws URL`,
      `Run \`awscalc service ${service.code}\` to see every configurable input`,
    ];
  }

  if (flags.json) return JSON.stringify(output, null, 2);
  return output;
}

async function priceGroup({
  service,
  definition,
  flags,
  region,
  currency,
  overrides,
  options,
}) {
  if (flags.template) {
    throw new AxiError(
      `--template does not apply to ${service.name}; it is a service group`,
      "VALIDATION_ERROR",
      [
        "Select sub-services with `--subservice <code>`",
        `Run \`awscalc service ${service.code}\` to list sub-service codes`,
      ],
    );
  }
  const available = (definition.templates ?? []).filter(
    (item) => typeof item === "string",
  );
  const selected =
    flags.subservice?.length > 0
      ? flags.subservice
      : definition.defaultTemplates ?? available;
  const invalid = selected.filter((code) => !available.includes(code));
  if (invalid.length > 0) {
    throw new AxiError(
      `Unknown sub-service${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`,
      "VALIDATION_ERROR",
      [`Valid sub-services: ${available.join(", ")}`],
    );
  }
  const names = await loadServiceNameMap(options);
  const manifest = await loadManifest(options);
  const byCode = new Map(manifest.map((item) => [item.code, item]));
  const collected = [];
  const warnings = [];
  const matchedKeys = new Set();
  const knownIds = new Set();

  for (const code of selected) {
    const subService = byCode.get(code);
    if (!subService) {
      warnings.push(`${code} is not in the calculator catalog; skipped`);
      continue;
    }
    const subDefinition = await loadDefinition(subService, options);
    const templates = (subDefinition.templates ?? []).filter(
      (item) => item?.id,
    );
    if (templates.length === 0) {
      warnings.push(`${code} has no configurable estimate; skipped`);
      continue;
    }
    const template = templates[0];
    const ids = inputIdsForTemplate(template);
    for (const id of ids) knownIds.add(id);
    const scoped = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (ids.has(key)) {
        scoped[key] = value;
        matchedKeys.add(key);
      }
    }
    const mappingDefinitions = mappingDefinitionsFor(subDefinition, template);
    let maps = new Map();
    let mapWarnings = [];
    let unsupportedMappings = new Set();
    if (mappingDefinitions.length > 0) {
      ({
        maps,
        warnings: mapWarnings,
        unsupportedMappings,
      } = await loadPricingMaps(mappingDefinitions, {
        region,
        currency,
        ...options,
      }));
      if (maps.size === 0) {
        warnings.push(
          `${code}: ${mapWarnings.join("; ") || "pricing is unavailable"}; skipped`,
        );
        continue;
      }
    }
    const engine = new Engine({
      definition: subDefinition,
      template,
      region,
      displayRegion: REGION_NAMES[region] ?? region,
      maps,
      currency,
      unsupportedMappings,
    });
    engine.resolveInputs(scoped);
    const result = engine.evaluate();
    collected.push({
      code,
      name: subDefinition.serviceName ?? subService.name,
      definition: subDefinition,
      template,
      result,
    });
    warnings.push(
      ...mapWarnings.map((warning) => `${code}: ${warning}`),
      ...result.warnings.map((warning) => `${code}: ${warning}`),
    );
  }

  const unmatched = Object.keys(overrides).filter(
    (key) => !matchedKeys.has(key),
  );
  if (unmatched.length > 0) {
    const selectedIds = [...knownIds];
    throw new AxiError(
      `Unknown input${unmatched.length > 1 ? "s" : ""} for ${definition.serviceName}: ${unmatched.join(", ")}`,
      "VALIDATION_ERROR",
      [
        `Selected sub-services: ${selected.join(", ")}`,
        `Available inputs: ${selectedIds.slice(0, 10).join(", ")}`,
        "Run `awscalc service <subservice-code>` for a specific schema",
        "If the input belongs to another sub-service, add it with --subservice",
      ],
    );
  }
  if (collected.length === 0) {
    throw new AxiError(
      `None of the selected sub-services could be priced`,
      "UNSUPPORTED_SERVICE",
      warnings.length > 0 ? warnings : ["Try a different --subservice"],
    );
  }

  const monthly = round2(
    collected.reduce((acc, item) => acc + item.result.monthly, 0),
  );
  const upfront = round2(
    collected.reduce((acc, item) => acc + item.result.upfront, 0),
  );
  const output = {
    service: service.name,
    code: service.code,
    template: definition.templateId,
    region,
    regionName: REGION_NAMES[region] ?? region,
    monthly,
    upfront,
    total12Months: round2(monthly * 12 + upfront),
    currency,
    subServices: collected.map((item) => ({
      code: item.code,
      name: item.name,
      monthly: item.result.monthly,
      upfront: item.result.upfront,
      summary: item.result.summary || null,
    })),
  };
  if (flags.explain) {
    output.items = collected.flatMap((item) =>
      item.result.costLines.map((line) => ({
        subService: item.code,
        card: line.card ?? "-",
        label: line.label,
        costType: line.costType,
        amount: line.amount,
      })),
    );
  }
  if (warnings.length > 0) output.warnings = [...new Set(warnings)];

  if (flags.share) {
    const entry = buildGroupServiceEntry({
      definition,
      region,
      subServices: collected,
      description: flags.description ?? null,
    });
    const payload = buildPayload({
      name: flags.name ?? `${service.name} estimate`,
      services: [entry],
      currency,
    });
    const saved = await saveEstimate(payload);
    output.url = saved.url;
    await recordEstimate({
      name: payload.name,
      service: service.name,
      code: service.code,
      region,
      monthly,
      upfront,
      url: saved.url,
      key: saved.key,
      cwd: process.cwd(),
    });
  } else {
    output.help = [
      `Run the same command with \`--share\` to publish a public calculator.aws URL`,
      `Run \`awscalc service ${service.code}\` to list sub-service codes`,
    ];
  }
  if (flags.json) return JSON.stringify(output, null, 2);
  return output;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validInputIds(engine) {
  const ids = [];
  for (const card of engine.cards()) {
    for (const component of card.inputSection?.components ?? []) {
      if (component.type === "input" && component.id) ids.push(component.id);
    }
  }
  return ids;
}

async function getCommand(args) {
  const { flags, positionals } = parseFlags("get", args);
  if (positionals.length === 0) {
    throw new AxiError("estimate URL or id is required", "VALIDATION_ERROR", [
      "Example: awscalc get https://calculator.aws/#/estimate?id=<id>",
    ]);
  }
  if (positionals.length > 1) {
    assertNoPositionals("get", positionals.slice(1));
  }
  const key = parseEstimateKey(positionals[0]);
  if (!key) {
    throw new AxiError(
      `Not a calculator.aws estimate URL or id: ${positionals[0]}`,
      "VALIDATION_ERROR",
      ["Expected https://calculator.aws/#/estimate?id=<id> or the bare id"],
    );
  }
  const estimate = await readEstimate(key, { full: flags.full });
  if (flags.json) return JSON.stringify(estimate, null, 2);
  const output = {
    estimate: {
      name: estimate.name,
      id: estimate.id,
      url: estimate.url,
      monthly: estimate.monthly,
      upfront: estimate.upfront,
      total12Months: estimate.total12Months,
      createdOn: estimate.createdOn,
    },
  };
  if (estimate.services.length === 0) {
    output.services = "estimate contains no services";
  } else {
    output.services = estimate.services.map((service) => ({
      name: service.name,
      region: service.region,
      monthly: service.monthly,
      upfront: service.upfront,
      config: flags.full
        ? service.config
        : truncate(service.config, 110),
    }));
  }
  if (flags.full) output.raw = estimate.raw;
  return output;
}

function truncate(text, length) {
  const value = String(text ?? "");
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

export async function main() {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: `awscalc — ${DESCRIPTION}

usage:
  awscalc                                   Recent estimates for this directory
  awscalc services [--filter text]          Browse the calculator catalog
  awscalc service <code> [--full]           Inspect inputs and templates
  awscalc regions --service <code>          List available regions
  awscalc price --service <code> [flags]    Compute a price (and --share)
  awscalc get <url|id>                      Read a published estimate

Run \`awscalc <command> --help\` for flags and examples.
`,
    getCommandHelp: (command) => COMMAND_HELP[command] ?? null,
    formatError: process.env.AWSCALC_DEBUG
      ? (error) => {
          if (error?.stack) process.stderr.write(`${error.stack}\n`);
          return {
            output: `${JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              code: error instanceof AxiError ? error.code : "UNKNOWN",
              help: error instanceof AxiError ? error.suggestions : undefined,
            })}\n`,
            exitCode: exitCodeForError(error),
          };
        }
      : undefined,
    home,
    commands: {
      services: servicesCommand,
      service: serviceCommand,
      regions: regionsCommand,
      price: priceCommand,
      get: getCommand,
    },
  });
}
