import { randomUUID } from "node:crypto";

import { AxiError } from "axi-sdk-js";

import {
  SIZE_LABEL,
  FREQ_LABEL,
  ceilTo,
  convertDuration,
  convertFrequency,
  convertSize,
  formatNumber,
  roundDownTo,
  roundHalfUp,
  roundUpTo,
} from "./units.js";
import {
  extractPrices,
  loadPlcContext,
  loadPlcIndex,
  selectAggregation,
} from "./plc.js";
import { regionName } from "./regions.js";
import { fetchJson } from "./http.js";
import {
  cheapestEc2Instance,
  EC2_DEDICATED_PER_REGION_FEE,
  EC2_OS_LABELS,
  EC2_TENANCY_LABELS,
  ec2OsSelection,
  extractEc2SavingsRate,
  findEc2Instance,
  findEc2Price,
  loadEc2Context,
  loadEc2HostContext,
  loadEc2HostIndex,
  loadEc2Index,
  loadEc2SavingsIndex,
  loadSpotAdvisor,
  selectEc2Aggregation,
  selectEc2HostAggregation,
  spotDiscountFor,
} from "./ec2.js";
import {
  breakevenHours,
  classifyWorkload,
  commitmentHours,
  effectiveHourlyRate,
  totalWorkloadHours,
  workloadFromInputs,
  workloadSummary,
} from "./workload.js";

const SUPPORTED_MATH = new Set([
  "basicMaths",
  "variable",
  "rounding",
  "maxMin",
  "tieredPricingMath",
  "snapShotMaths",
  "ec2AdvPricingStrategyMath",
  "workloadInstanceMath",
  "workloadStorageMath",
  "dedicatedHostsMath",
]);

const SUPPORTED_PRICING = new Set([
  "singlePricePoint",
  "pricingComboV2",
  "tieredPricing",
  "replace",
  "concatenate",
  "ec2PriceFetcher",
]);

const SUPPORTED_INPUT = new Set([
  "numericInput",
  "dropdown",
  "frequency",
  "fileSize",
  "durationInput",
  "percentInput",
  "throughput",
  "utilization",
  "checkbox",
  "alert",
  "bodyText",
  "headerText",
  "condition",
  "columnFormIPM",
  "radioTiles",
  "workload",
  "ec2InstanceSearch",
  "ec2AdvPricingStrategyV2",
  "ec2AdvPricingMetrics",
  "dataTransferV2",
]);

const NON_VALUE_INPUT = new Set([
  "alert",
  "bodyText",
  "headerText",
  "condition",
]);

// CLI aliases for the single row of a columnFormIPM instance table.
export const COLUMN_ROW_ALIASES = {
  instanceType: "Instance Type",
  nodes: "Number of Nodes",
  deployment: "Deployment Option",
  pricingModel: "TermType",
  term: "LeaseContractLength",
  purchaseOption: "PurchaseOption",
  utilization: "utilization",
  engine: "Cache Engine",
  instanceFamily: "Instance Family",
  databaseEngine: "Database Engine",
  computeFamily: "Compute Family",
  location: "port:Direct Connect Location",
  portType: "port:Connection Type",
  portCapacity: "port:Capacity",
  workspaces: "Number of WorkSpaces",
  operatingSystem: "Operating System",
  license: "License",
  bundleName: "Bundle Description",
  productFamily: "Product Family",
  rootVolume: "rootVolume",
  userVolume: "userVolume",
  runningMode: "Running Mode",
  billingOption: "BillingOption",
};

function normalizeToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function asNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeTerm(term) {
  const text = String(term ?? "").toLowerCase();
  if (/^1|\b1\s*(?:yr|year)/.test(text)) return "1yr";
  if (/^3|\b3\s*(?:yr|year)/.test(text)) return "3yr";
  return String(term ?? "");
}

function normalizePurchaseOption(option) {
  const text = String(option ?? "").toLowerCase();
  if (text.includes("all")) return "All Upfront";
  if (text.includes("partial")) return "Partial Upfront";
  if (text.includes("no")) return "No Upfront";
  return String(option ?? "");
}

function normalizeEc2Strategy(text) {
  const value = String(text ?? "").toLowerCase();
  if (value.includes("cost") || value.includes("reserved and on-demand"))
    return "cost-optimized";
  if (value.includes("on-demand") || value.includes("ondemand")) return "on-demand";
  if (value.includes("convertible")) return "convertible";
  if (value.includes("reserved") || value.includes("standard")) return "standard";
  if (value.includes("compute")) return "compute-savings";
  if (value.includes("instance")) return "instance-savings";
  if (value.includes("spot")) return "spot";
  return "compute-savings";
}

function normalizeEc2Term(text) {
  const value = String(text ?? "").toLowerCase();
  return /1/.test(value) ? 1 : 3;
}

function maybeNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

function splitValueAndUnit(text) {
  const raw = String(text).trim();
  const match = raw.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/i);
  if (!match) return { value: raw, unit: "" };
  return { value: Number(match[1]), unit: match[2].trim() };
}

const SIZE_ALIASES = {
  b: "bytes",
  byte: "bytes",
  bytes: "bytes",
  kb: "kb",
  kib: "kb",
  mb: "mb",
  mib: "mb",
  gb: "gb",
  gib: "gb",
  tb: "tb",
  tib: "tb",
  pb: "pb",
  pib: "pb",
};

const FREQ_ALIASES = {
  persecond: "perSecond",
  second: "perSecond",
  seconds: "perSecond",
  sec: "perSecond",
  s: "perSecond",
  perminute: "perMinute",
  minute: "perMinute",
  minutes: "perMinute",
  min: "perMinute",
  perhour: "perHour",
  hour: "perHour",
  hours: "perHour",
  hr: "perHour",
  perday: "perDay",
  day: "perDay",
  days: "perDay",
  perweek: "perWeek",
  week: "perWeek",
  weeks: "perWeek",
  permonth: "perMonth",
  month: "perMonth",
  months: "perMonth",
  monthly: "perMonth",
  mo: "perMonth",
  thousandpermonth: "thousandPerMonth",
  thousandspermonth: "thousandPerMonth",
  millionpermonth: "millionPerMonth",
  millionspermonth: "millionPerMonth",
  billionpermonth: "billionPerMonth",
  permillisecond: "perMillisecond",
  millisecond: "perMillisecond",
  ms: "perMillisecond",
};

const TIME_ALIASES = {
  ms: "ms",
  millisecond: "ms",
  milliseconds: "ms",
  sec: "sec",
  second: "sec",
  seconds: "sec",
  min: "min",
  minute: "min",
  minutes: "min",
  hour: "hour",
  hours: "hour",
  hr: "hour",
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month",
};

function parseFrequencyUnit(text) {
  const token = normalizeToken(text);
  return FREQ_ALIASES[token] ?? FREQ_ALIASES[token.replace(/^per/, "")] ?? null;
}

function parseSizeUnit(text) {
  return SIZE_ALIASES[normalizeToken(text)] ?? null;
}

function parseTimeUnit(text) {
  return TIME_ALIASES[normalizeToken(text)] ?? null;
}

const DATA_UNIT_TO_GB = {
  b: 1 / 1024 ** 3,
  byte: 1 / 1024 ** 3,
  bytes: 1 / 1024 ** 3,
  kb: 1 / 1024 ** 2,
  kib: 1 / 1024 ** 2,
  mb: 1 / 1024,
  mib: 1 / 1024,
  gb: 1,
  gib: 1,
  tb: 1024,
  tib: 1024,
  pb: 1024 ** 2,
  pib: 1024 ** 2,
};

function parseTransferUnit(value) {
  const unit = String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\/month|permonth|monthly|month/g, "");
  return DATA_UNIT_TO_GB[unit] ?? null;
}

function parseTransferAmount(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zA-Z/]+)?/);
  if (!match) {
    throw new AxiError(`Could not read data transfer amount "${raw}"`, "VALIDATION_ERROR", [
      "Use a size such as 1TB, 500GB, or 0.5tb_month",
    ]);
  }
  const value = Number(match[1]);
  const unit = parseTransferUnit(match[2] ?? "tb");
  if (unit == null) {
    throw new AxiError(`Unknown data transfer unit "${match[2]}"`, "VALIDATION_ERROR", [
      "Use B, KB, MB, GB, TB, or PB",
    ]);
  }
  return { value, gb: value * unit };
}

function normalizeTransferType(value) {
  const text = String(value ?? "outbound").toLowerCase();
  if (text.includes("intra")) return "INTRA_REGION";
  if (text.includes("in")) return "INBOUND";
  if (text.includes("inter")) return "OUTBOUND";
  return "OUTBOUND";
}

/**
 * Parse a dataTransferV2 value. Accepted forms:
 *   "OUTBOUND:1TB; INTRA_REGION:100GB"
 *   "OUTBOUND:1TB@us-west-2; INBOUND:2TB@eu-west-1"
 *   "1TB" (external outbound)
 *   a JSON array or object of transfer entries
 */
export function parseDataTransferEntries(value, displayRegion) {
  if (value == null || value === "") return [];
  const fromRaw = (entry) => {
    const direct = entry.value ?? entry.amount ?? 0;
    const unit = entry.unit;
    const amountText =
      typeof direct === "string" && /[a-z]/i.test(direct)
        ? direct
        : `${direct}${unit && !String(unit).includes("_month") ? unit : ""}`;
    const amount = parseTransferAmount(amountText);
    const gb =
      unit === "gb_month" && typeof direct !== "string" ? Number(direct) : amount.gb;
    return {
      entryType: normalizeTransferType(entry.entryType ?? entry.type),
      value: Number((gb / 1024).toFixed(6)),
      unit: "tb_month",
      gb,
      fromRegion:
        entry.fromRegion ??
        (normalizeTransferType(entry.entryType ?? entry.type) === "INBOUND"
          ? "External"
          : null),
      toRegion:
        entry.toRegion ??
        (normalizeTransferType(entry.entryType ?? entry.type) === "OUTBOUND"
          ? "External"
          : null),
      optionType: entry.optionType?.type ?? entry.optionType ?? null,
    };
  };
  if (typeof value === "object") {
    const list = Array.isArray(value)
      ? value
      : Array.isArray(value.value)
        ? value.value
        : value.entryType
          ? [value]
          : [];
    return list.map(fromRaw);
  }
  const text = String(value).trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return parseDataTransferEntries(JSON.parse(text), displayRegion);
    } catch (error) {
      throw new AxiError(
        `Could not parse data transfer JSON: ${error.message}`,
        "VALIDATION_ERROR",
      );
    }
  }
  const specs = text.split(/[;\n]+/).map((item) => item.trim()).filter(Boolean);
  return specs.map((spec) => {
    let type = "OUTBOUND";
    let region = null;
    let amountText = spec;
    const typed = spec.match(/^([a-zA-Z_ -]+?)\s*[:=]\s*(.+)$/);
    if (typed) {
      type = normalizeTransferType(typed[1]);
      amountText = typed[2];
    }
    const at = amountText.match(/^(.+?)@(.+)$/);
    if (at) {
      amountText = at[1];
      region = at[2];
    }
    const amount = parseTransferAmount(amountText);
    return {
      entryType: type,
      value: Number((amount.gb / 1024).toFixed(6)),
      unit: "tb_month",
      gb: amount.gb,
      fromRegion: type === "INBOUND" ? region ?? "External" : null,
      toRegion: type === "OUTBOUND" ? region ?? "External" : null,
      optionType: null,
    };
  });
}

/**
 * Parse a Dedicated Host list for the Windows workloads `workflow=dedicated`
 * mode. Accepted forms:
 *   "c5:2, m5:1"
 *   "c5 x2; m5"
 *   [{ "hostFamily": "c5", "instances": 2 }]
 * Counts are host counts, not server counts.
 */
export function parseDedicatedHosts(value) {
  if (value == null || value === "") return [];
  const fromRaw = (entry) => {
    if (typeof entry === "string") {
      const text = entry.trim();
      const counted = text.match(
        /^([A-Za-z][A-Za-z0-9.-]*?)\s*(?:[:xX*]\s*|\s+)(\d+)$/,
      );
      const bare = text.match(/^([A-Za-z][A-Za-z0-9.-]*)$/);
      const match = counted ?? bare;
      if (!match) return null;
      return { family: match[1], instances: Number(match[2] ?? 1) };
    }
    if (!entry || typeof entry !== "object") return null;
    const family =
      entry.hostFamily ??
      entry.family ??
      entry.hostType ??
      entry.instanceType ??
      entry.type;
    if (!family) return null;
    const count =
      entry.instances ?? entry.hosts ?? entry.count ?? entry.quantity ?? 1;
    return { family: String(family), instances: Number(count) };
  };
  let entries;
  if (Array.isArray(value)) {
    entries = value.map(fromRaw);
  } else if (typeof value === "object") {
    if (Array.isArray(value.value)) {
      entries = value.value.map(fromRaw);
    } else if (value.hostFamily || value.family || value.instanceType) {
      entries = [fromRaw(value)];
    } else {
      entries = Object.entries(value).map(([family, count]) => ({
        family,
        instances: Number(count),
      }));
    }
  } else {
    const text = String(value).trim();
    if (text.startsWith("[") || text.startsWith("{")) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new AxiError(
          `Could not parse dedicated host JSON: ${error.message}`,
          "VALIDATION_ERROR",
        );
      }
      return parseDedicatedHosts(parsed);
    }
    entries = text
      .split(/[;,\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map(fromRaw);
  }
  const hosts = entries.filter(Boolean);
  for (const host of hosts) {
    if (!host.family || !Number.isInteger(host.instances) || host.instances < 1) {
      throw new AxiError(
        `Invalid dedicated host entry "${JSON.stringify(host)}"`,
        "VALIDATION_ERROR",
        ['Use a host list such as --set hosts="c5:2, m5:1"'],
      );
    }
  }
  return hosts;
}

export class Engine {
  constructor({
    definition,
    template,
    region,
    displayRegion,
    maps,
    currency,
    unsupportedMappings = new Set(),
    fetchOptions = {},
  }) {
    this.definition = definition;
    this.template = template;
    this.region = region;
    this.displayRegion = displayRegion;
    this.maps = maps;
    this.unsupportedMappings = unsupportedMappings;
    this.fetchOptions = fetchOptions;
    this.currency = currency ?? "USD";
    this.values = new Map();
    this.rawInputs = new Map();
    this.pricingValues = new Map();
    this.costLines = [];
    this.warnings = [];
    this.summary = [];
    this.trace = [];
    this.usedComponents = new Set();
    this.handledComponents = new Set();
    this.hiddenComponents = new Set();
  }

  get units() {
    if (!this._units) {
      this._units = new Set();
      for (const map of this.maps.values()) {
        for (const unit of map.units) this._units.add(unit);
      }
    }
    return this._units;
  }

  hasUnit(mappingName, unit) {
    if (mappingName) {
      const map = this.maps.get(mappingName);
      return Boolean(map && map.units.has(unit));
    }
    return this.units.has(unit);
  }

  warning(message) {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  cardIsVisible(card) {
    return this.evaluateCondition(card.displayIf, {});
  }

  evaluateCondition(condition, extra) {
    if (condition == null) return true;
    if (typeof condition === "boolean") return condition;
    if (Array.isArray(condition)) {
      return condition.every((item) => this.evaluateCondition(item, extra));
    }
    if (typeof condition !== "object") return Boolean(condition);
    if ("and" in condition) {
      return condition.and.every((item) => this.evaluateCondition(item, extra));
    }
    if ("or" in condition) {
      return condition.or.some((item) => this.evaluateCondition(item, extra));
    }
    if ("not" in condition) {
      return !this.evaluateCondition(condition.not, extra);
    }
    if ("exists" in condition) {
      return this.operandExists(condition.exists, extra);
    }
    if ("checkboxChecked" in condition) {
      const value = this.resolveConditionOperand(
        condition.checkboxChecked,
        extra,
      );
      return Boolean(value);
    }
    if ("checkboxNotChecked" in condition) {
      const value = this.resolveConditionOperand(
        condition.checkboxNotChecked,
        extra,
      );
      return !value;
    }
    if ("template" in condition) {
      return this.template?.id === condition.template;
    }
    for (const operator of ["==", "!=", ">", ">=", "<", "<="]) {
      if (operator in condition) {
        const [leftRaw, rightRaw] = condition[operator];
        let left = this.resolveConditionOperand(leftRaw, extra);
        let right = this.resolveConditionOperand(rightRaw, extra);
        if (
          (typeof left === "number" && typeof right === "string") ||
          (typeof left === "string" && typeof right === "number")
        ) {
          left = maybeNumber(left);
          right = maybeNumber(right);
        }
        switch (operator) {
          case "==":
            return left === right;
          case "!=":
            return left !== right;
          case ">":
            return Number(left) > Number(right);
          case ">=":
            return Number(left) >= Number(right);
          case "<":
            return Number(left) < Number(right);
          case "<=":
            return Number(left) <= Number(right);
          default:
            break;
        }
      }
    }
    if (condition.type === "component") {
      return this.values.get(condition.id);
    }
    if (condition.type === "meteredUnit") {
      return this.hasUnit(condition.mappingDefinitionName, condition.meteredUnit);
    }
    return true;
  }

  resolveConditionOperand(operand, extra) {
    if (operand == null) return operand;
    if (Array.isArray(operand) || typeof operand !== "object") return operand;
    if ("constant" in operand) return maybeNumber(operand.constant);
    if (operand.type === "component") {
      if (extra && Object.hasOwn(extra, operand.id)) return extra[operand.id];
      if (this.hiddenComponents.has(operand.id)) return undefined;
      if (this.values.has(operand.id)) return this.values.get(operand.id);
      const component = this.findComponent(operand.id);
      if (component) return this.defaultInputValue(component).converted;
      return undefined;
    }
    if (operand.type === "meteredUnit") {
      return this.hasUnit(operand.mappingDefinitionName, operand.meteredUnit);
    }
    if ("id" in operand) {
      return this.values.get(operand.id);
    }
    return operand;
  }

  operandExists(operand) {
    if (!operand) return false;
    if (operand.type === "meteredUnit") {
      return this.hasUnit(operand.mappingDefinitionName, operand.meteredUnit);
    }
    if (operand.type === "component") {
      const value = this.values.get(operand.id);
      return value !== undefined && value !== null && value !== "";
    }
    return Boolean(operand);
  }

  findComponent(id) {
    if (!this._components) {
      this._components = new Map();
      for (const card of this.cards()) {
        for (const component of card.inputSection?.components ?? []) {
          if (component.id) this._components.set(component.id, component);
        }
        for (const group of card.mathsSection ?? []) {
          for (const component of group.components ?? []) {
            if (component.id) this._components.set(component.id, component);
          }
        }
      }
    }
    return this._components.get(id);
  }

  cards() {
    return this.template?.cards ?? [];
  }

  /** Resolve all inputs (with user overrides) and pricing lookups. */
  async resolveInputs(overrides = {}) {
    const seenOverrides = new Set();
    if (this.definition.serviceCode === "windowsWorkloads") {
      await this.resolveWindowsWorkloads(overrides, seenOverrides);
      return { unknown: [] };
    }
    let columnIndex = 0;
    const allComponents = this.cards().flatMap(
      (card) => card.inputSection?.components ?? [],
    );
    const hasColumnForm = allComponents.some(
      (component) => component.subType === "columnFormIPM",
    );
    const hasEc2 = allComponents.some(
      (component) =>
        component.subType === "ec2InstanceSearch" ||
        component.subType === "ec2PriceFetcher",
    );
    if (hasEc2) {
      await this.resolveEc2(overrides, seenOverrides);
    }
    for (const card of this.cards()) {
      if (!this.cardIsVisible(card)) {
        for (const component of card.inputSection?.components ?? []) {
          if (component.id) this.hiddenComponents.add(component.id);
        }
        continue;
      }
      const components = card.inputSection?.components ?? [];
      for (const component of components) {
        if (this.handledComponents.has(component.id)) continue;
        if (!this.evaluateCondition(component.displayIf, {})) {
          if (component.id) this.hiddenComponents.add(component.id);
          continue;
        }
        if (component.type === "pricing") {
          this.resolvePricing(component);
          continue;
        }
        if (component.type !== "input") continue;
        if (component.subType === "columnFormIPM") {
          columnIndex += 1;
          const suffix = columnIndex === 1 ? "" : String(columnIndex);
          const pseudo = {};
          for (const [alias, selector] of Object.entries(COLUMN_ROW_ALIASES)) {
            const key = `${alias}${suffix}`;
            if (overrides[key] !== undefined) {
              pseudo[selector] = overrides[key].text;
              seenOverrides.add(key);
            }
          }
          await this.resolveColumnFormIPM(component, pseudo, columnIndex);
          continue;
        }
        const provided =
          overrides[component.id] ?? this.suppliedByLabel(component, overrides);
        if (provided !== undefined && provided !== null) {
          seenOverrides.add(provided.key ?? component.id);
        }
        this.resolveInput(component, provided);
      }
    }
    const unknown = Object.keys(overrides).filter(
      (id) =>
        !seenOverrides.has(id) &&
        !this.findComponent(id) &&
        !(
          hasColumnForm &&
          Object.keys(COLUMN_ROW_ALIASES).some(
            (alias) => id === alias || id === `${alias}2` || id === `${alias}3`,
          )
        ) &&
        !(
          hasEc2 &&
          ["instanceType", "instances", "term", "upfront", "workload"].includes(id)
        ),
    );
    return { unknown };
  }

  findMapping(name) {
    const mappings = [
      ...(this.definition.mappingDefinitions ?? []),
      ...(this.template.mappingDefinitions ?? []),
    ];
    return mappings.find((mapping) => mapping.mappingDefinitionName === name);
  }

  /** Resolve the EC2 instance/workload/pricing-strategy widgets. */
  async resolveEc2(overrides, seenOverrides) {
    const components = this.cards().flatMap(
      (card) => card.inputSection?.components ?? [],
    );
    const bySubType = (subType) =>
      components.find((component) => component.subType === subType);
    const tenancyComponent = this.findComponent("tenancy");
    const osComponent = this.findComponent("selectedOS");
    const workloadSelection =
      bySubType("radioTiles") ?? this.findComponent("workloadSelection");
    const workloadComponent =
      bySubType("workload") ?? this.findComponent("workload");
    const instanceComponent =
      bySubType("ec2InstanceSearch") ?? this.findComponent("instanceType");
    const strategyComponent =
      bySubType("ec2AdvPricingStrategyV2") ??
      this.findComponent("pricingStrategy");
    const metricsComponent =
      bySubType("ec2AdvPricingMetrics") ??
      this.findComponent("ec2AdvancedPricingMetrics");
    const fetcher = bySubType("ec2PriceFetcher");
    const mathComponent = this.cards()
      .flatMap((card) =>
        (card.mathsSection ?? []).flatMap((group) => group.components ?? []),
      )
      .find((component) => component.subType === "ec2AdvPricingStrategyMath");
    const quick = !workloadComponent && Boolean(this.findComponent("quantity"));

    const consume = (component, aliases = []) => {
      if (!component) return undefined;
      for (const alias of [component.id, ...aliases]) {
        if (overrides[alias] !== undefined) {
          seenOverrides.add(alias);
          return overrides[alias];
        }
      }
      return undefined;
    };
    const consumeKey = (keys = []) => {
      for (const key of keys) {
        if (overrides[key] !== undefined) {
          seenOverrides.add(key);
          return overrides[key];
        }
      }
      return undefined;
    };
    const textOf = (value) =>
      value && typeof value === "object" && "text" in value
        ? String(value.text)
        : value;

    if (tenancyComponent) {
      const provided = consume(tenancyComponent);
      this.resolveInput(tenancyComponent, provided);
      this.handledComponents.add(tenancyComponent.id);
    }
    if (osComponent) {
      const provided = consume(osComponent);
      this.resolveInput(osComponent, provided);
      this.handledComponents.add(osComponent.id);
    }

    const tenancyValue = this.values.get("tenancy") ?? "shared";
    const osValue = this.values.get("selectedOS") ?? "linux";
    const tenancyLabel =
      EC2_TENANCY_LABELS[tenancyValue] ??
      String(tenancyValue).replace(/^./, (char) => char.toUpperCase());
    const osOption = (osComponent?.options ?? []).find(
      (option) => option.id === osValue,
    );
    const osLabel =
      osOption?.label ?? EC2_OS_LABELS[osValue] ?? String(osValue);
    const osSelection = ec2OsSelection(osValue, osLabel);

    if (quick) {
      await this.resolveQuickEc2({
        overrides,
        seenOverrides,
        components,
        consume,
        consumeKey,
        tenancyLabel,
        osSelection,
      });
      return;
    }

    const workloadTypeText =
      textOf(consume(workloadSelection)) ??
      workloadSelection?.defaultSelection ??
      "consistent";
    const workloadExplicit = consume(workloadComponent, [
      "workloadData",
      "workload-json",
    ]);
    const rawWorkloadInputs = {
      workloadSelection: workloadTypeText,
      instances:
        textOf(consume(workloadComponent, ["instances", "quantity"])) ??
        textOf(consumeKey(["instances", "quantity"])) ??
        workloadComponent?.defaultValue ??
        1,
      workload: textOf(workloadExplicit),
      baseline: textOf(consumeKey(["baseline"])),
      peak: textOf(consumeKey(["peak"])),
      spikeDays: textOf(consumeKey(["spikeDays", "days"])),
      spikeHours: textOf(consumeKey(["spikeHours", "hours"])),
      spikeMinutes: textOf(consumeKey(["spikeMinutes", "minutes"])),
      workloadDays: textOf(consumeKey(["workloadDays", "selectedDays"])),
    };
    const workload = workloadFromInputs(rawWorkloadInputs);

    const strategyText =
      textOf(consume(strategyComponent)) ??
      strategyComponent?.defaultValue ??
      "compute-savings";
    const termText = textOf(consumeKey(["term"])) ?? "3 Year";
    const upfrontText = textOf(consumeKey(["upfront"])) ?? "None";
    seenOverrides.add("term");
    seenOverrides.add("upfront");

    const strategy = normalizeEc2Strategy(strategyText);
    if (
      !/on-?demand|compute|instance|spot|standard|convertible|cost|reserved/i.test(
        String(strategyText),
      )
    ) {
      throw new AxiError(
        `Unknown EC2 pricing strategy "${strategyText}"`,
        "VALIDATION_ERROR",
        [
          "Use on-demand, compute-savings, instance-savings, cost-optimized, standard, convertible, or spot",
        ],
      );
    }
    const term = normalizeEc2Term(termText);
    const purchaseOption = normalizePurchaseOption(upfrontText);
    const reservedTerm = strategy === "standard" || strategy === "convertible"
      ? strategy
      : strategy === "cost-optimized"
        ? "standard"
        : null;
    const needsReserved = Boolean(reservedTerm);
    const needsSavings =
      strategy === "compute-savings" || strategy === "instance-savings";

    const instanceProvided = textOf(consume(instanceComponent));
    const isHost = tenancyValue === "host";

    let onDemandRate = 0;
    let instanceType;
    let reservedPrice = null;
    let savingsRate = null;
    let spotDiscount = 0;
    let display = this.displayRegion;

    if (isHost) {
      const hostContext = await loadEc2HostContext({
        region: this.region,
        currency: this.currency,
        ...this.fetchOptions,
      });
      display = hostContext.display;
      const onDemandAgg = selectEc2HostAggregation(hostContext, {
        instanceType: instanceProvided,
        termType: "OnDemand",
      });
      instanceType = onDemandAgg.selectors["Instance Type"];
      const { data: onDemandIndex } = await loadEc2HostIndex(
        hostContext,
        onDemandAgg,
        this.fetchOptions,
      );
      onDemandRate = findEc2Price(onDemandIndex, display, instanceType).hourly;
      if (needsReserved) {
        const reservedAgg = selectEc2HostAggregation(hostContext, {
          instanceType,
          termType: "Reserved",
        });
        const { data: reservedIndex } = await loadEc2HostIndex(
          hostContext,
          reservedAgg,
          this.fetchOptions,
        );
        const all = findEc2Price(reservedIndex, display, instanceType);
        reservedPrice = this.pickReservedOption(all.entries, {
          term,
          purchaseOption,
          offering: reservedTerm,
        });
      }
      if (needsSavings) {
        const savingsIndex = await loadEc2SavingsIndex(
          hostContext,
          {
            kind: strategy,
            term,
            purchaseOption,
            os: "Linux",
            preInstalled: "NA",
            tenancy: "Host",
          },
          this.fetchOptions,
        );
        savingsRate = extractEc2SavingsRate(savingsIndex, display, {
          kind: strategy,
          term,
          purchaseOption,
          instanceType,
        });
        if (savingsRate == null) {
          throw new AxiError(
            `No ${strategy} Savings Plan rate found for ${instanceType} in ${display}`,
            "VALIDATION_ERROR",
            ["Try --set pricingStrategy=on-demand"],
          );
        }
      }
    } else {
      const context = await loadEc2Context({
        region: this.region,
        currency: this.currency,
        ...this.fetchOptions,
      });
      display = context.display;
      const selected = selectEc2Aggregation(context, {
        tenancy: tenancyLabel,
        os: osSelection.os,
        preInstalled: osSelection.preInstalled,
        termType: "OnDemand",
      });
      const { data: indexData } = await loadEc2Index(
        context,
        selected.aggregation,
        this.fetchOptions,
      );
      const instanceEntry = instanceProvided
        ? findEc2Instance(indexData, display, instanceProvided)
        : cheapestEc2Instance(indexData, display);
      instanceType = instanceEntry["Instance Type"];
      onDemandRate = Number(instanceEntry.price) || 0;

      if (needsReserved) {
        const reservedSelected = selectEc2Aggregation(context, {
          tenancy: tenancyLabel,
          os: osSelection.os,
          preInstalled: osSelection.preInstalled,
          termType: "Reserved",
          lease: `${term}yr`,
          purchase: purchaseOption,
          offering: reservedTerm,
        });
        const { data: reservedIndex } = await loadEc2Index(
          context,
          reservedSelected.aggregation,
          this.fetchOptions,
        );
        const all = findEc2Price(reservedIndex, display, instanceType);
        reservedPrice = {
          hourly: all.hourly,
          upfront: all.upfront,
          monthly: all.hourly * 730,
        };
      }

      if (needsSavings) {
        const savingsIndex = await loadEc2SavingsIndex(
          context,
          {
            kind: strategy,
            term,
            purchaseOption,
            os: osSelection.os,
            preInstalled: osSelection.preInstalled,
            tenancy: tenancyLabel,
          },
          this.fetchOptions,
        );
        savingsRate = extractEc2SavingsRate(savingsIndex, display, {
          kind: strategy,
          term,
          purchaseOption,
          instanceType,
        });
        if (savingsRate == null) {
          throw new AxiError(
            `No ${strategy} Savings Plan rate found for ${instanceType} in ${display}`,
            "VALIDATION_ERROR",
            ["Try --set pricingStrategy=on-demand"],
          );
        }
      }
    }

    if (strategy === "spot") {
      const advisor = await loadSpotAdvisor(this.fetchOptions);
      spotDiscount = spotDiscountFor(advisor, {
        region: this.region,
        os: osSelection.os,
        instanceType,
      });
    }

    const totalHours = totalWorkloadHours(workload, 0);
    const perRegionFeeHours =
      isHost || tenancyValue !== "dedicated" ? 0 : Math.min(totalHours, 730);
    const perRegionFee = perRegionFeeHours * EC2_DEDICATED_PER_REGION_FEE;

    const costs = {
      onDemandCost: 0,
      upfrontCost: 0,
      monthlyCost: 0,
      instanceSavingsCost: 0,
      computeSavingsCost: 0,
      totalHours,
    };
    let summaryLabel = "On-Demand";
    let savingsPlanUpfront = 0;
    let savingsPlanMonthly = 0;

    if (needsSavings) {
      const years = term;
      const upfrontCost = this.savingsPlanUpfront(
        savingsRate,
        years,
        purchaseOption,
      );
      const effective = effectiveHourlyRate(years, savingsRate, upfrontCost);
      savingsPlanUpfront = upfrontCost;
      savingsPlanMonthly = effective * 730;
      const breakeven = breakevenHours({
        termYears: years,
        upfrontCost,
        monthlyCost: savingsPlanMonthly,
        effectiveRate: effective,
        onDemandRate,
      });
      const utilization = classifyWorkload(workload, breakeven);
      const reservedCost = utilization.reservedCount * savingsPlanMonthly;
      const onDemandCost = utilization.onDemandHours * onDemandRate;
      costs.onDemandCost = roundHalfUp(onDemandCost, 2);
      costs.upfrontCost = roundHalfUp(utilization.reservedCount * upfrontCost, 2);
      if (strategy === "compute-savings") costs.computeSavingsCost = roundHalfUp(reservedCost, 2);
      else costs.instanceSavingsCost = roundHalfUp(reservedCost, 2);
      summaryLabel =
        strategy === "instance-savings"
          ? `EC2 Instance Savings Plans ${term}yr ${purchaseOption}`
          : `Compute Savings Plans ${term}yr ${purchaseOption}`;
    } else if (strategy === "on-demand") {
      costs.onDemandCost = roundHalfUp(onDemandRate * totalHours + perRegionFee, 2);
      summaryLabel = "On-Demand";
    } else if (strategy === "spot") {
      const discounted = onDemandRate * totalHours * (1 - spotDiscount / 100);
      costs.onDemandCost = roundHalfUp(discounted + perRegionFee, 2);
      summaryLabel = `Spot Discount: ${spotDiscount}`;
    } else if (strategy === "cost-optimized") {
      const breakeven = breakevenHours({
        termYears: term,
        upfrontCost: reservedPrice?.upfront ?? 0,
        monthlyCost: reservedPrice?.monthly ?? 0,
        onDemandRate,
      });
      const utilization = classifyWorkload(workload, breakeven);
      const reservedCost = utilization.reservedCount * (reservedPrice?.monthly ?? 0);
      const onDemandCost = utilization.onDemandHours * onDemandRate;
      costs.onDemandCost = roundHalfUp(onDemandCost, 2);
      costs.upfrontCost = roundHalfUp(
        utilization.reservedCount * (reservedPrice?.upfront ?? 0),
        2,
      );
      costs.monthlyCost = roundHalfUp(reservedCost, 2);
      summaryLabel = `Reserved ${term}yr ${purchaseOption} (cost optimized)`;
    } else {
      // Standard and Convertible Reserved Instances run everything reserved.
      const utilization = classifyWorkload(workload, 0);
      const count =
        workload.workloadType === "consistent"
          ? Number(utilization.reservedCount) || 0
          : Number(utilization.reservedCount) || 0;
      costs.monthlyCost = roundHalfUp(
        count * (reservedPrice?.monthly ?? 0) + perRegionFee,
        2,
      );
      costs.upfrontCost = roundHalfUp(count * (reservedPrice?.upfront ?? 0), 2);
      summaryLabel = `${strategy === "convertible" ? "Convertible" : "Standard"} Reserved Instances ${term}yr ${purchaseOption}`;
    }

    this.values.set("totalHours", totalHours);
    if (mathComponent) this.values.set(mathComponent.id, costs);
    if (fetcher) {
      this.handledComponents.add(fetcher.id);
      this.pricingValues.set(fetcher.id, {
        kind: "ec2PriceFetcher",
        onDemandRate,
        savingsRate,
        instanceType,
        tenancy: tenancyValue,
      });
      this.values.set(fetcher.id, onDemandRate);
    }

    const strategyState =
      strategy === "spot"
        ? { selectedOption: "spot", spotDiscountPercentage: String(spotDiscount) }
        : strategy === "on-demand"
          ? {
              selectedOption: "on-demand",
              term: "1 year",
              utilizationValue: "100",
              utilizationUnit: "%Utilized/Month",
            }
          : strategy === "standard" || strategy === "convertible"
            ? {
                selectedOption: strategy,
                term: `${term} Year`,
                upfrontPayment:
                  purchaseOption === "No Upfront" ? "None" : purchaseOption,
                model: strategy === "convertible" ? "Yes" : "No",
              }
            : {
                selectedOption: strategy,
                term: `${term} Year`,
                upfrontPayment:
                  purchaseOption === "No Upfront" ? "None" : purchaseOption,
                model:
                  strategy === "instance-savings"
                    ? "instanceSavings"
                    : strategy === "compute-savings"
                      ? "computeSavings"
                      : "No",
              };
    if (workloadComponent) {
      this.rawInputs.set(workloadComponent.id, { value: workload });
      this.handledComponents.add(workloadComponent.id);
    }
    if (workloadSelection) {
      this.rawInputs.set(workloadSelection.id, {
        value: workload.workloadType,
      });
      this.handledComponents.add(workloadSelection.id);
    }
    if (instanceComponent) {
      this.rawInputs.set(instanceComponent.id, { value: instanceType });
      this.handledComponents.add(instanceComponent.id);
    }
    if (strategyComponent) {
      this.rawInputs.set(strategyComponent.id, { value: strategyState });
      this.handledComponents.add(strategyComponent.id);
    }
    if (metricsComponent) {
      this.values.set(metricsComponent.id, 1);
      this.rawInputs.set(metricsComponent.id, { value: 1 });
      this.handledComponents.add(metricsComponent.id);
    }
    if (savingsPlanUpfront || savingsPlanMonthly) {
      this.values.set("ec2SavingsPlanUpfront", savingsPlanUpfront);
      this.values.set("ec2SavingsPlanMonthly", savingsPlanMonthly);
    }

    this.summary.push({
      id: "workload",
      label: "Workload",
      text: workloadSummary(workload),
    });
    this.summary.push({
      id: instanceComponent?.id ?? "instanceType",
      label: instanceComponent?.label ?? "Advance EC2 instance",
      text: `${instanceComponent?.label ?? "Advance EC2 instance"} (${instanceType})`,
    });
    this.summary.push({
      id: strategyComponent?.id ?? "pricingStrategy",
      label: strategyComponent?.label ?? "Pricing strategy",
      text: `Pricing strategy (${summaryLabel})`,
    });
  }

  pickReservedOption(entries, { term, purchaseOption, offering }) {
    const termValue = `${term}yr`;
    const offeringValue = offering === "convertible" ? "convertible" : "standard";
    const matches = (entry) => {
      const lease = normalizeTerm(entry.LeaseContractLength ?? "");
      const purchase = normalizeToken(entry.PurchaseOption ?? "");
      const desiredPurchase = normalizeToken(purchaseOption);
      const offeringClass = entry.OfferingClass;
      return (
        lease === termValue &&
        purchase === desiredPurchase &&
        (offeringClass == null ||
          normalizeToken(offeringClass) === normalizeToken(offeringValue))
      );
    };
    const hourly = entries.filter(
      (entry) => matches(entry) && /hour|hrs/i.test(String(entry.Unit ?? "")),
    );
    const upfront = entries.filter(
      (entry) => matches(entry) && /quantity/i.test(String(entry.Unit ?? "")),
    );
    return {
      hourly: Number(hourly[0]?.price ?? 0) || 0,
      upfront: Number(upfront[0]?.price ?? 0) || 0,
      monthly: (Number(hourly[0]?.price ?? 0) || 0) * 730,
    };
  }

  savingsPlanUpfront(rate, years, purchaseOption) {
    const hours = commitmentHours(years);
    const fraction =
      purchaseOption === "All Upfront"
        ? 1
        : purchaseOption === "Partial Upfront"
          ? 0.5
          : 0;
    return roundHalfUp(Number(rate) * hours * fraction, 2);
  }

  async resolveQuickEc2({
    overrides,
    seenOverrides,
    components,
    consume,
    consumeKey,
    tenancyLabel,
    osSelection,
  }) {
    const textOf = (value) =>
      value && typeof value === "object" && "text" in value
        ? String(value.text)
        : value;
    const instanceComponent = components.find(
      (component) => component.subType === "instanceFinder",
    );
    const strategyComponent = components.find(
      (component) => component.subType === "pricingStrategy",
    );
    const quantityComponent = components.find(
      (component) => component.id === "quantity",
    );
    const utilizationComponent = components.find(
      (component) => component.id === "utilization",
    );
    const instanceProvided = consume(instanceComponent);
    const quantityText =
      consume(quantityComponent)?.text ?? quantityComponent?.defaultValue ?? 1;
    const utilizationText =
      consume(utilizationComponent)?.text ??
      utilizationComponent?.defaultValue ??
      100;
    const quantity = Math.max(1, asNumber(quantityText));
    const utilization = Math.max(0, asNumber(utilizationText));

    const strategyValue = normalizeEc2Strategy(
      textOf(consume(strategyComponent)) ??
        strategyComponent?.radioGroups?.[0]?.defaultOption ??
        "instanceSavings",
    );
    const radioGroups = strategyComponent?.radioGroups ?? [];
    const termGroup = radioGroups.find((group) => group.value === "term");
    const paymentGroup = radioGroups.find((group) => group.value === "options");
    const term = normalizeEc2Term(
      textOf(consumeKey(["term"])) ?? termGroup?.defaultOption ?? "3yr",
    );
    const purchaseOption = normalizePurchaseOption(
      textOf(consumeKey(["upfront"])) ?? paymentGroup?.defaultOption ?? "NoUpfront",
    );

    const context = await loadEc2Context({
      region: this.region,
      currency: this.currency,
      ...this.fetchOptions,
    });
    const selected = selectEc2Aggregation(context, {
      tenancy: tenancyLabel,
      os: osSelection.os,
      preInstalled: osSelection.preInstalled,
      termType: "OnDemand",
    });
    const { data: indexData } = await loadEc2Index(
      context,
      selected.aggregation,
      this.fetchOptions,
    );
    const instanceEntry = instanceProvided
      ? findEc2Instance(indexData, context.display, instanceProvided)
      : cheapestEc2Instance(indexData, context.display);
    const instanceType = instanceEntry["Instance Type"];
    const onDemandRate = Number(instanceEntry.price) || 0;

    const reservedSelected = selectEc2Aggregation(context, {
      tenancy: tenancyLabel,
      os: osSelection.os,
      preInstalled: osSelection.preInstalled,
      termType: "Reserved",
      lease: `${term}yr`,
      purchase: purchaseOption,
      offering: "standard",
    });
    const { data: reservedIndex } = await loadEc2Index(
      context,
      reservedSelected.aggregation,
      this.fetchOptions,
    );
    const reserved = findEc2Price(reservedIndex, context.display, instanceType);

    const savingsRates = {};
    for (const kind of ["compute-savings", "instance-savings"]) {
      const savingsIndex = await loadEc2SavingsIndex(
        context,
        {
          kind,
          term,
          purchaseOption,
          os: osSelection.os,
          preInstalled: osSelection.preInstalled,
          tenancy: tenancyLabel,
        },
        this.fetchOptions,
      );
      savingsRates[kind] =
        extractEc2SavingsRate(savingsIndex, context.display, {
          kind,
          term,
          purchaseOption,
          instanceType,
        }) ?? 0;
    }
    const savingsUpfront = (rate) =>
      this.savingsPlanUpfront(rate, term, purchaseOption);
    const savingsEffective = (rate) =>
      effectiveHourlyRate(term, rate, savingsUpfront(rate));

    const prices = components.filter(
      (component) =>
        component.type === "input" &&
        component.subType === "priceSelector" &&
        component.id?.startsWith("quickEstimate_generated_"),
    );
    const rateByLabel = {
      upfront: reserved.upfront,
      reserved: reserved.hourly,
      instance: savingsEffective(savingsRates["instance-savings"]),
      ondemand: onDemandRate,
      compute: savingsEffective(savingsRates["compute-savings"]),
    };
    for (const component of prices) {
      const label = String(component.label ?? "").toLowerCase();
      let value = 0;
      if (label.includes("upfront")) value = rateByLabel.upfront;
      else if (label.includes("reserved")) value = rateByLabel.reserved;
      else if (label.includes("instance savings")) value = rateByLabel.instance;
      else if (label.includes("ondemand") || label.includes("on-demand"))
        value = rateByLabel.ondemand;
      else if (label.includes("compute savings")) value = rateByLabel.compute;
      this.values.set(component.id, value);
      this.rawInputs.set(component.id, { value });
      this.handledComponents.add(component.id);
    }

    const strategyText = textOf(consume(strategyComponent));
    const selectedOption = strategyText ?? strategyValue;
    const quickState = {
      model: strategyValue,
      term: `${term}yr`,
      options: purchaseOption,
    };
    if (strategyComponent) {
      this.rawInputs.set(strategyComponent.id, { value: quickState });
      this.handledComponents.add(strategyComponent.id);
    }
    if (instanceComponent) {
      this.rawInputs.set(instanceComponent.id, { value: instanceType });
      this.handledComponents.add(instanceComponent.id);
    }
    if (quantityComponent) {
      // Leave calculationComponents to the normal input resolver.
      seenOverrides.delete(quantityComponent.id);
    }
    if (utilizationComponent) {
      seenOverrides.delete(utilizationComponent.id);
    }

    this.summary.push({
      id: instanceComponent?.id ?? "instanceType",
      label: instanceComponent?.label ?? "Instance type",
      text: `${instanceComponent?.label ?? "Instance type"} (${instanceType})`,
    });
    this.summary.push({
      id: strategyComponent?.id ?? "pricingStrategy",
      label: strategyComponent?.label ?? "Pricing strategy",
      text: `Pricing strategy (${selectedOption})`,
    });
    this.values.set("totalHours", quantity * utilization);
  }

  findAdditionalPricingItem(component, termType, name) {
    const items = component.additionalPricingData ?? [];
    return items.find((item) => {
      const constantTerm = item.remap?.constant?.TermType;
      if (constantTerm && normalizeToken(constantTerm) === normalizeToken(termType)) {
        return true;
      }
      return name && normalizeToken(item.name) === normalizeToken(name);
    });
  }

  /**
   * Resolve a Database Savings Plan or compute/instance Savings Plan index for
   * a columnFormIPM row. These live in sibling pricing artifacts.
   */
  async loadAdditionalPricing(item, options = {}) {
    const source = item.manifest?.source;
    const serviceId = item.manifest?.serviceId;
    if (!source || !serviceId) return null;
    const display = encodeURIComponent(this.displayRegion);
    const base = "https://calculator.aws/pricing/2.0/meteredUnitMaps";
    const findRate = (data, instanceType) => {
      const region =
        data?.regions?.[this.displayRegion] ??
        Object.values(data?.regions ?? {})[0] ??
        {};
      const entries = Object.entries(region);
      const hit =
        entries.find(([, entry]) =>
          Object.entries(entry ?? {}).some(
            ([key, value]) =>
              key.endsWith("InstanceType") ||
              key === "Instance Type" ||
              key === "rds:Instance Type"
                ? value === instanceType
                : false,
          ),
        ) ??
        entries.find(([key]) => key.includes(` ${instanceType} `)) ??
        entries.find(([, entry]) => entry?.InstanceFamily === instanceType);
      if (!hit) return null;
      const price = Number(hit[1]?.price);
      return Number.isFinite(price) ? price : null;
    };

    try {
      if (/^databasesavingsplans$/i.test(serviceId)) {
        const lease =
          options.term === "3yr" ? "3 years" : "1 year";
        const path = [
          base,
          serviceId,
          this.currency,
          "current",
          source,
          display,
          encodeURIComponent(lease),
          encodeURIComponent(options.purchaseOption ?? "No Upfront"),
          encodeURIComponent(options.deployment ?? "Single-AZ"),
          encodeURIComponent(options.databaseEngine ?? "MySQL"),
          "index.json",
        ].join("/");
        const data = await fetchJson(path, this.fetchOptions);
        const rate = findRate(data, options.instanceType);
        if (rate == null) return null;
        return { rate, kind: "savings" };
      }
      if (/^computesavingsplan$/i.test(serviceId)) {
        const artifactSource = /instance/i.test(item.name)
          ? "instance-ec2-calc"
          : "compute-ec2-calc";
        const path = [
          base,
          serviceId,
          this.currency,
          "current",
          artifactSource,
          display,
          "Host",
          "Linux",
          "NA",
          String(options.termYears ?? 3),
          encodeURIComponent(options.purchaseOption ?? "No Upfront"),
          "index.json",
        ].join("/");
        const data = await fetchJson(path, this.fetchOptions);
        const rate = findRate(data, options.instanceType);
        if (rate == null) return null;
        return { rate, kind: "savings" };
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Price the Windows Server and SQL Server workload calculator (shared tenancy). */
  async resolveWindowsWorkloads(overrides, seenOverrides) {
    const components = this.cards().flatMap(
      (card) => card.inputSection?.components ?? [],
    );
    const find = (id) => components.find((component) => component.id === id);
    const take = (keys, fallback) => {
      for (const key of keys) {
        if (overrides[key] !== undefined) {
          seenOverrides.add(key);
          return overrides[key]?.value ?? overrides[key]?.text;
        }
      }
      return fallback;
    };
    const bool = (value, fallback) => {
      if (value === undefined || value === null || value === "") return fallback;
      if (typeof value === "boolean") return value;
      return /^(true|yes|y|1|on)$/i.test(String(value));
    };
    const machineId = String(take(["machineId"], "machine1"));
    const quantity = Math.max(1, asNumber(take(["quantity", "instances"], 1)));
    const description = String(
      take(["machineDescription", "description"], "Server 1"),
    );
    const cpu = asNumber(take(["cpuInput", "vcpus", "cpu"], 4));
    const memory = asNumber(take(["memoryInput", "memory"], 16));
    const passive = asNumber(take(["machineSpecificationSqlPassiveNode"], 0));
    const optimizeCpus = asNumber(take(["optimizeCpus"], cpu));

    const bringWindows = bool(
      take(["bringWindowsLicense"], undefined),
      find("bringWindowsLicense")?.defaultValue ?? false,
    );
    const bringSQL = bool(
      take(["bringSQLLicense"], undefined),
      find("sqlLicenseCheckboxes")?.options?.find((o) => o.id === "bringSQLLicense")
        ?.prechecked ?? true,
    );
    const haveSA = bool(
      take(["haveSoftwareAssurance"], undefined),
      find("sqlLicenseCheckboxes")?.options?.find(
        (o) => o.id === "haveSoftwareAssurance",
      )?.prechecked ?? true,
    );

    const workflow = String(take(["workflow", "tenancyWorkflow"], "shared"));
    if (workflow === "dedicated") {
      await this.resolveWindowsDedicatedHosts({
        take,
        components,
        sqlServerVersion: take(
          ["sqlServerVersion", "machineSpecificationSQLServerVersion", "sql"],
          null,
        ),
      });
      return;
    }
    if (workflow !== "shared") {
      throw new AxiError(
        `Windows workload workflow "${workflow}" is not supported`,
        "UNSUPPORTED_SERVICE",
        [
          "Use --set workflow=shared",
          "Use --set workflow=dedicated with --set hosts=\"c5:2\" for Dedicated Hosts",
        ],
      );
    }

    const osId = String(
      take(["operatingSystem", "machineSpecificationOperatingSystem"], null) ??
        (bringWindows ? "windows-byol" : "windows-li"),
    );
    const defaultSql = bringSQL && haveSA ? "std-byol" : "std-li";
    const sqlId = String(
      take(
        ["sqlServerVersion", "machineSpecificationSQLServerVersion", "sql"],
        null,
      ) ?? defaultSql,
    );
    if (/developer/i.test(sqlId)) {
      throw new AxiError(
        "SQL Server Developer edition is not supported by the calculator price index",
        "UNSUPPORTED_SERVICE",
      );
    }
    const sqlByol = /-byol$/i.test(sqlId) || sqlId === "no-sql";
    const sqlPreinstalled = sqlByol
      ? "NA"
      : /enterprise/i.test(sqlId)
        ? "SQL Ent"
        : /web/i.test(sqlId)
          ? "SQL Web"
          : "SQL Std";
    const osMap = {
      "windows-li": ["Windows", sqlPreinstalled],
      "windows-byol": ["Linux", sqlPreinstalled],
      linux: ["Linux", sqlPreinstalled],
      rhel: ["RHEL", sqlPreinstalled],
      suse: ["SUSE", sqlPreinstalled],
    };
    const [ec2Os, preInstalled] = osMap[osId] ?? ["Windows", sqlPreinstalled];

    const strategyText = String(
      take(["pricingStrategy", "pricingModel"], null) ?? "reserved",
    );
    const strategy = normalizeEc2Strategy(strategyText);
    const term = normalizeEc2Term(
      String(take(["term"], null) ?? "1 Year"),
    );
    const purchaseOption = normalizePurchaseOption(
      String(take(["upfront"], null) ?? "No Upfront"),
    );
    const instanceProvided = take(
      [
        "instanceType",
        "instanceTypeSearch",
        "machineSpecificationInstanceType",
      ],
      null,
    );

    const context = await loadEc2Context({
      region: this.region,
      currency: this.currency,
      ...this.fetchOptions,
    });
    const onDemandAgg = selectEc2Aggregation(context, {
      tenancy: "Shared",
      os: ec2Os,
      preInstalled,
      termType: "OnDemand",
    });
    const { data: onDemandIndex } = await loadEc2Index(
      context,
      onDemandAgg.aggregation,
      this.fetchOptions,
    );
    let instanceEntry;
    let selectionChoice = "advancedView";
    if (instanceProvided) {
      instanceEntry = findEc2Instance(
        onDemandIndex,
        context.display,
        String(instanceProvided),
      );
    } else {
      selectionChoice = "quickView";
      const candidates = Object.values(
        onDemandIndex.regions?.[context.display] ?? {},
      )
        .filter((entry) => {
          const vcpu = Number(entry.vCPU ?? 0);
          const mem = Number(String(entry.Memory ?? "0").replace(/[^\d.]/g, ""));
          const type = String(entry["Instance Type"] ?? "");
          const family = type.split(".")[0];
          // The recommendation excludes burstable, AMD, and Graviton
          // families; it keeps current-generation Intel-compatible instances.
          const excludedFamily =
            /^t/i.test(family) ||
            /a$/i.test(family) ||
            /g/i.test(family) ||
            /metal/i.test(type);
          return (
            vcpu >= cpu &&
            mem >= memory &&
            (entry["Current Generation"] ?? "Yes") === "Yes" &&
            !excludedFamily
          );
        })
        .sort((a, b) => Number(a.price) - Number(b.price));
      if (candidates.length === 0) {
        throw new AxiError(
          `No EC2 instance in ${context.display} meets ${cpu} vCPU / ${memory} GiB`,
          "VALIDATION_ERROR",
          ["Pass --set instanceType=<type> to pick an instance explicitly"],
        );
      }
      instanceEntry = candidates[0];
    }
    const instanceType = instanceEntry["Instance Type"];
    const vcpus = instanceEntry.vCPU ?? String(cpu);
    const onDemandRate = Number(instanceEntry.price) || 0;

    let unitMonthly = onDemandRate * 730;
    let unitUpfront = 0;
    let subTotalMonthly = "totalOnDemandPrice";
    if (strategy === "standard" || strategy === "convertible") {
      const offering = strategy === "convertible" ? "convertible" : "standard";
      const selected = selectEc2Aggregation(context, {
        tenancy: "Shared",
        os: ec2Os,
        preInstalled,
        termType: "Reserved",
        lease: `${term}yr`,
        purchase: purchaseOption,
        offering,
      });
      const { data } = await loadEc2Index(
        context,
        selected.aggregation,
        this.fetchOptions,
      );
      const price = findEc2Price(data, context.display, instanceType);
      unitMonthly = price.hourly * 730;
      unitUpfront = price.upfront;
      subTotalMonthly =
        strategy === "convertible"
          ? "totalMonthlyConvertibleReservedPrice"
          : "totalMonthlyStandardReservedPrice";
    } else if (strategy === "compute-savings" || strategy === "instance-savings") {
      const savingsIndex = await loadEc2SavingsIndex(
        context,
        {
          kind: strategy,
          term,
          purchaseOption,
          os: ec2Os,
          preInstalled,
          tenancy: "Shared",
        },
        this.fetchOptions,
      );
      const rate = extractEc2SavingsRate(savingsIndex, context.display, {
        kind: strategy,
        term,
        purchaseOption,
        instanceType,
      });
      if (rate == null) {
        throw new AxiError(
          `No ${strategy} Savings Plan rate found for ${instanceType} in ${context.display}`,
          "VALIDATION_ERROR",
        );
      }
      const upfront = this.savingsPlanUpfront(rate, term, purchaseOption);
      const effective = effectiveHourlyRate(term, rate, upfront);
      unitMonthly = effective * 730;
      unitUpfront = upfront;
      subTotalMonthly =
        strategy === "instance-savings"
          ? "totalMonthlyInstanceSavingsPrice"
          : "totalMonthlyComputeSavingsPrice";
    }

    const totalMonthly = roundHalfUp(quantity * unitMonthly, 2);
    const totalUpfront = roundHalfUp(quantity * unitUpfront, 2);
    this.values.set(subTotalMonthly, totalMonthly);
    this.values.set("totalInstanceUpfrontPrice", totalUpfront);

    // Storage: one gp3 1000 GiB volume unless the caller supplies a volume.
    const storageType = String(
      take(["storageType", "volumeType"], "General Purpose (gp3)"),
    );
    const storageAmount = asNumber(
      take(["storageAmount", "volumeSize"], 1000),
    );
    const storageIops = asNumber(take(["storageIops", "iops"], 0));
    const storageThroughput = asNumber(
      take(["storageThroughput", "throughput"], 0),
    );
    const ebs = this.maps.get("ebs");
    const ebsPrice = (unit) => ebs?.priceFor(unit) ?? 0;
    let storageUnit = 0;
    if (/gp3/i.test(storageType)) {
      storageUnit = storageAmount * ebsPrice("Storage General Purpose gp3 GB Mo");
      storageUnit +=
        Math.max(0, storageIops - 3000) *
        ebsPrice("Provisioned EBS IOPS gp3 Volumes per IOPS Mo");
      storageUnit +=
        (Math.max(0, storageThroughput - 125) / 1024) *
        ebsPrice("Provisioned Throughput gp3 per GiBps mo");
    } else if (/gp2/i.test(storageType) || /^General Purpose$/i.test(storageType)) {
      storageUnit = storageAmount * ebsPrice("Storage General Purpose gp2 GB Mo");
    } else if (/io2/i.test(storageType)) {
      storageUnit = storageAmount * ebsPrice("Storage Provisioned IOPS io2 GB month");
      const tiers = [
        [32000, "Provisioned EBS IOPS io2 Volumes per IOPS Mo"],
        [32000, "Provisioned EBS IOPS Tier 2 io2 Volumes per IOPS Mo"],
        [Infinity, "Provisioned EBS IOPS Tier 3 io2 Volumes per IOPS Mo"],
      ];
      let remaining = storageIops;
      for (const [limit, unit] of tiers) {
        const used = Math.min(remaining, limit);
        storageUnit += used * ebsPrice(unit);
        remaining -= used;
        if (remaining <= 0) break;
      }
    } else if (/io1/i.test(storageType)) {
      storageUnit =
        storageAmount * ebsPrice("Storage Provisioned IOPS io1 GB Mo") +
        storageIops * ebsPrice("Provisioned EBS IOPS io1 Volumes per IOPS Mo");
    } else if (/st1|Throughput/i.test(storageType)) {
      storageUnit = storageAmount * ebsPrice("Storage Throughput Optimized HDD st1 GB Mo");
    } else if (/sc1|Cold HDD/i.test(storageType)) {
      storageUnit = storageAmount * ebsPrice("Storage Cold HDD sc1 GB Mo");
    }
    const totalStorage = roundHalfUp(storageUnit * quantity, 2);
    this.values.set("totalStorageCost", totalStorage);

    const volumeId = "volume1";
    const pricingValue = {
      model: strategy,
      term: `${term} Year`,
      upfrontPayment:
        purchaseOption === "No Upfront" ? "None" : purchaseOption,
    };
    const raw = {
      sharedTenancy: { value: [machineId] },
      windowsLicenseCheckboxes: {
        checkedStates: { bringWindowsLicense: bringWindows },
      },
      bringWindowsLicense: { value: bringWindows },
      sqlLicenseCheckboxes: {
        checkedStates: {
          bringSQLLicense: bringSQL,
          haveSoftwareAssurance: haveSA,
        },
      },
      bringSQLLicense: { value: bringSQL },
      haveSoftwareAssurance: { value: haveSA },
      workflow: { value: "shared" },
      pricingStrategyDedicatedHosts: { value: pricingValue },
      pricingStrategy: { value: pricingValue },
      dhRecommendationWorkflow: {
        value: {
          uploadedFile: null,
          recommendationResult: [],
          hostToServersMapping: {},
          hostToLicensesMapping: {},
          machineSpecs: {},
          recommendationInProgress: false,
        },
        initialState: null,
        calculationString: null,
        configSummaryString: null,
        subType: "workflowInstruction",
        isInError: false,
        userState: null,
        conversionStrings: null,
        touched: null,
      },
      workloadInstanceMath: {
        subType: "workloadInstanceMath",
        value: {
          [machineId]: {
            instanceType,
            quantity: String(quantity),
            sqlServer: sqlId,
            vcpus: String(vcpus),
            windowsServer: osId,
          },
        },
      },
      workloadStorageMath: {
        subType: "workloadStorageMath",
        value: {
          [machineId]: {
            [storageType]: [
              {
                iops: storageIops,
                throughput: storageThroughput,
                volumeCount: 1,
                volumeSize: storageAmount,
              },
            ],
          },
        },
      },
      [`machineSpecificationDescription_${machineId}`]: { value: description },
      [`machineSpecificationStorage_${machineId}`]: {
        value: {
          [volumeId]: {
            volumeType: { value: storageType },
            provisionedIops: storageIops
              ? { value: String(storageIops) }
              : {},
            volumeSize: { value: String(storageAmount) },
            volumeThroughput: storageThroughput
              ? { value: String(storageThroughput) }
              : {},
          },
        },
      },
      [`machineSpecificationOperatingSystem_${machineId}`]: { value: osId },
      [`machineSpecificationSQLServerVersion_${machineId}`]: { value: sqlId },
      [`instanceSelectionChoice_${machineId}`]: { value: selectionChoice },
      [`machineSpecificationQuantity_${machineId}`]: {
        value: String(quantity),
      },
      [`cpuInput_${machineId}`]: { value: String(cpu) },
      [`memoryInput_${machineId}`]: { value: String(memory) },
      [`machineSpecificationSqlPassiveNode_${machineId}`]: {
        value: String(passive),
      },
      [`optimizeCpus_${machineId}`]: { value: String(optimizeCpus) },
    };
    if (selectionChoice === "advancedView") {
      raw[`instanceTypeSearch_${machineId}`] = { value: instanceType };
    }
    for (const [id, value] of Object.entries(raw)) {
      this.rawInputs.set(id, value);
    }
    for (const component of components) {
      if (component.id) this.handledComponents.add(component.id);
    }
    this.summary.push({
      id: "windowsWorkload",
      label: "Windows workload",
      text: `Windows workload (${description}: ${instanceType} x ${quantity})`,
    });
    this.summary.push({
      id: "windowsStorage",
      label: "Storage",
      text: `Storage (${storageType}, ${storageAmount} GB)`,
    });
  }

  /**
   * Windows workloads on Dedicated Hosts (`workflow=dedicated`).
   * The calculator's upload/review tables recommend hosts from machine specs;
   * awscalc instead takes the host list explicitly and prices it with the same
   * dedicatedhost-calc artifacts. The generated review state makes
   * "Update estimate" recompute the same host costs.
   */
  async resolveWindowsDedicatedHosts({ take, components, sqlServerVersion }) {
    const strategyText = String(
      take(["pricingStrategy", "pricingModel"], "reserved"),
    );
    const strategy = normalizeEc2Strategy(strategyText);
    if (!["standard", "on-demand", "compute-savings", "instance-savings"].includes(strategy)) {
      throw new AxiError(
        `Pricing strategy "${strategyText}" is not available for Dedicated Hosts`,
        "UNSUPPORTED_SERVICE",
        [
          "Use --set pricingStrategy=reserved, on-demand, compute-savings, or instance-savings",
        ],
      );
    }
    const term = normalizeEc2Term(String(take(["term"], "1 Year")));
    const purchaseOption = normalizePurchaseOption(
      String(take(["upfront"], "No Upfront")),
    );
    const sqlId = String(sqlServerVersion ?? "std-byol");
    if (/developer/i.test(sqlId)) {
      throw new AxiError(
        "SQL Server Developer edition is not supported by the calculator price index",
        "UNSUPPORTED_SERVICE",
      );
    }
    if (!/^no-sql$/i.test(sqlId) && !/-byol$/i.test(sqlId)) {
      throw new AxiError(
        "SQL Server license included is not available on Dedicated Hosts",
        "UNSUPPORTED_SERVICE",
        [
          "Use a BYOL SQL Server edition (std-byol, enterprise-byol, web-byol) or no-sql",
          "Price SQL Server license included with --set workflow=shared",
        ],
      );
    }

    let hosts = parseDedicatedHosts(
      take(["hosts", "dedicatedHosts", "hostList"], null),
    );
    if (hosts.length === 0) {
      const family = take(["hostType", "hostFamily"], null);
      if (family) {
        hosts = [
          {
            family: String(family),
            instances: Math.max(1, asNumber(take(["hostCount"], 1))),
          },
        ];
      }
    }
    if (hosts.length === 0) {
      throw new AxiError(
        "Dedicated Host pricing needs a host list",
        "VALIDATION_ERROR",
        [
          'Pass --set hosts="c5:2, m5:1"',
          'Or set --set hostType=c5 --set hostCount=2',
          "Run `awscalc price --service ec2 --set tenancy=host` for a single host family",
        ],
      );
    }

    const hostContext = await loadEc2HostContext({
      region: this.region,
      currency: this.currency,
      ...this.fetchOptions,
    });
    const display = hostContext.display;
    const rateCache = new Map();
    const rateFor = async (family) => {
      if (rateCache.has(family)) return rateCache.get(family);
      let rate;
      if (strategy === "on-demand") {
        const aggregation = selectEc2HostAggregation(hostContext, {
          instanceType: family,
          termType: "OnDemand",
        });
        const { data } = await loadEc2HostIndex(
          hostContext,
          aggregation,
          this.fetchOptions,
        );
        const price = findEc2Price(data, display, family);
        rate = { hourly: price.hourly, upfront: 0 };
      } else if (strategy === "standard") {
        const aggregation = selectEc2HostAggregation(hostContext, {
          instanceType: family,
          termType: "Reserved",
        });
        const { data } = await loadEc2HostIndex(
          hostContext,
          aggregation,
          this.fetchOptions,
        );
        const all = findEc2Price(data, display, family);
        const picked = this.pickReservedOption(all.entries, {
          term,
          purchaseOption,
          offering: "standard",
        });
        rate = { hourly: picked.hourly, upfront: picked.upfront };
      } else {
        const savingsIndex = await loadEc2SavingsIndex(
          hostContext,
          {
            kind: strategy,
            term,
            purchaseOption,
            os: "Linux",
            preInstalled: "NA",
            tenancy: "Host",
          },
          this.fetchOptions,
        );
        const hourly = extractEc2SavingsRate(savingsIndex, display, {
          kind: strategy,
          term,
          purchaseOption,
          instanceType: family,
        });
        if (hourly == null) {
          throw new AxiError(
            `No ${strategy} Savings Plan rate found for Dedicated Host ${family} in ${display}`,
            "VALIDATION_ERROR",
            ["Try --set pricingStrategy=on-demand"],
          );
        }
        rate = { hourly, upfront: 0 };
      }
      rateCache.set(family, rate);
      return rate;
    };

    const recommendation = [];
    const costItems = [];
    let index = 0;
    for (const host of hosts) {
      const rate = await rateFor(host.family);
      for (let count = 0; count < host.instances; count += 1) {
        index += 1;
        const description = `Host ${index}`;
        const monthly = rate.hourly * 730;
        recommendation.push({
          id: index - 1,
          hostFamily: host.family,
          description,
          instances: 1,
          licenseCount: 0,
          unusedVCPUs: 0,
          unusedVCPUsPercentage: 100,
          usedVCPUs: 0,
          usedCapacity: 0,
        });
        costItems.push({
          HostFamily: host.family,
          DH: description,
          InstanceHourlyCost: 0,
          HostHourlyCost: rate.hourly,
          HourlyCost: rate.hourly,
          UpfrontCost: rate.upfront,
          MonthlyCost: monthly,
        });
      }
    }
    const monthly = roundHalfUp(
      costItems.reduce((acc, item) => acc + item.MonthlyCost, 0),
      2,
    );
    const upfront = roundHalfUp(
      costItems.reduce((acc, item) => acc + item.UpfrontCost, 0),
      2,
    );
    this.values.set("totalMonthlyDedicatedHostsPrice", monthly);
    this.values.set("totalUpfrontDedicatedHostsPrice", upfront);
    this.values.set("dedicatedHostsMath", { monthly, upfront });

    const plan =
      strategy === "on-demand"
        ? "ondemand"
        : strategy === "compute-savings"
          ? "computeSavings"
          : strategy === "instance-savings"
            ? "instanceSavings"
            : "reserved";
    const termId = `${term} Year`;
    const upfrontLegacy =
      purchaseOption === "All Upfront"
        ? "Full"
        : purchaseOption === "Partial Upfront"
          ? "Partial"
          : "None";
    const pricingValue = {
      model: plan,
      term: termId,
      upfrontPayment: upfrontLegacy,
    };
    const hasSql = !/^no-sql$/i.test(sqlId);
    const raw = {
      sharedTenancy: {
        value: [],
        initialState: { value: [] },
        subType: "templateDynamicCards",
      },
      workflow: { value: "dedicated" },
      bringWindowsLicense: { value: true },
      windowsLicenseCheckboxes: {
        checkedStates: { bringWindowsLicense: true },
      },
      windowsLicensePurchaseDate: { value: "before" },
      bringSQLLicense: { value: hasSql },
      haveSoftwareAssurance: { value: hasSql },
      sqlLicenseCheckboxes: {
        checkedStates: {
          bringSQLLicense: hasSql,
          haveSoftwareAssurance: hasSql,
        },
      },
      sqlLicensePurchaseDate: { value: hasSql ? "before" : null },
      pricingStrategyDedicatedHosts: {
        value: pricingValue,
        subType: "pricingStrategy",
      },
      pricingStrategy: {
        value: { model: "standard", term: "1 Year", upfrontPayment: "None" },
      },
      workloadInstanceMath: { value: {}, subType: "workloadInstanceMath" },
      workloadStorageMath: { value: {}, subType: "workloadStorageMath" },
      dhRecommendationWorkflow: {
        value: {
          uploadedFile: null,
          recommendationResult: recommendation,
          hostToServersMapping: {},
          hostToLicensesMapping: {},
          machineSpecs: {},
          recommendationInProgress: false,
        },
        initialState: null,
        calculationString: null,
        configSummaryString: null,
        subType: "workflowInstruction",
        isInError: false,
        userState: null,
        conversionStrings: null,
        touched: null,
      },
      dhPricingMap: { value: {} },
      dhCostTableAllItems: { value: costItems },
      totalMonthlyDedicatedHostsPrice: {
        value: monthly,
        subType: "dedicatedHostsMath",
      },
      totalUpfrontDedicatedHostsPrice: {
        value: upfront,
        subType: "dedicatedHostsMath",
      },
    };
    for (const [id, value] of Object.entries(raw)) {
      this.rawInputs.set(id, value);
    }
    for (const component of components) {
      if (component.id) this.handledComponents.add(component.id);
    }
    const hostSummary = hosts
      .map((host) => `${host.family} x ${host.instances}`)
      .join(", ");
    this.summary.push({
      id: "windowsWorkload",
      label: "Windows workload",
      text: `Windows workload (Dedicated Hosts: ${hostSummary})`,
    });
    this.summary.push({
      id: "dedicatedHostPricing",
      label: "Pricing",
      text: `Pricing (${strategy === "standard" ? "Reserved" : strategy} ${term}yr ${purchaseOption})`,
    });
  }

  selectPlcAggregation(context, desired, requiredKeys = []) {
    try {
      return selectAggregation(context, desired);
    } catch {
      const aggregations = context.aggregation?.aggregations ?? [];
      for (const key of requiredKeys.filter(Boolean)) {
        const value = desired[key];
        if (value == null || value === "") continue;
        const hasValue = aggregations.some(
          (entry) => String(entry.selectors?.[key]) === String(value),
        );
        if (!hasValue) {
          throw new AxiError(
            `No calculator price matches ${key}=${value} in ${context.display}`,
            "VALIDATION_ERROR",
            ["Run `awscalc service <code>` to inspect the available values"],
          );
        }
      }
      const scored = aggregations.map((entry) => {
        let score = 0;
        for (const [key, value] of Object.entries(desired)) {
          if (value == null || value === "") continue;
          if (String(entry.selectors?.[key]) === String(value)) {
            score += key === "TermType" ? 4 : 2;
          }
        }
        return { entry, score };
      });
      scored.sort((a, b) => b.score - a.score);
      if (!scored[0] || scored[0].score === 0) {
        throw new AxiError(
          `No calculator price matches ${JSON.stringify(desired)} in ${context.display}`,
          "VALIDATION_ERROR",
          ["Run `awscalc service <code>` to inspect the selector values"],
        );
      }
      return scored[0].entry;
    }
  }

  /** Resolve a columnFormIPM instance table row via the PLC 2.0 price index. */
  async resolveColumnFormIPM(component, pseudo = {}, index = 1) {
    const rows = component.row ?? [];
    const bySelector = (selector) =>
      rows.find((row) => row.selectorId === selector);
    const byExport = (name) =>
      rows.find((row) => row.exportValueAs === name);
    const nodeRow =
      byExport("count") ??
      bySelector("Number of Nodes") ??
      rows.find(
        (row) =>
          (row.type === "textInput" || row.type === "numericInput") &&
          /\bnodes?\b/i.test(String(row.label ?? "")),
      );
    const instanceRow =
      bySelector("Instance Type") ?? bySelector("Compute Family");
    const utilizationRow = rows.find((row) => row.type === "utilization");
    const deploymentRow = bySelector("Deployment Option");
    const termTypeRow = bySelector("TermType");
    const leaseRow = bySelector("LeaseContractLength");
    const purchaseRow = bySelector("PurchaseOption");

    const mapping = this.findMapping(component.mappingDefinitionName);
    if (!mapping) {
      throw new AxiError(
        `Missing PLC metadata for ${component.id}`,
        "UNSUPPORTED_SERVICE",
      );
    }
    const context = await loadPlcContext(mapping, {
      region: this.region,
      currency: this.currency,
      ...this.fetchOptions,
    });

    const aggregations = context.aggregation?.aggregations ?? [];
    const deployment =
      pseudo["Deployment Option"] ??
      (aggregations.some(
        (entry) => entry.selectors?.["Deployment Option"] === "Single-AZ",
      )
        ? "Single-AZ"
        : aggregations[0]?.selectors?.["Deployment Option"]);
    const hasTermSelector = (context.meta.primarySelectors ?? [])
      .concat(context.meta.secondarySelectors ?? [])
      .includes("TermType");
    const termType =
      pseudo["TermType"] ??
      termTypeRow?.defaultValue ??
      "OnDemand";
    const additionalItem = this.findAdditionalPricingItem(component, termType);
    const reserved =
      /reserved/i.test(String(termType)) || Boolean(additionalItem);
    if (
      hasTermSelector &&
      !reserved &&
      termType !== "OnDemand" &&
      termType !== "Hourly"
    ) {
      throw new AxiError(
        `Pricing model "${termType}" is not supported yet for this service`,
        "UNSUPPORTED_SERVICE",
        [
          "Use `--set pricingModel=OnDemand` or `pricingModel=Reserved`",
          `Pricing model "${termType}" needs an additional pricing artifact`,
        ],
      );
    }
    const term = reserved
      ? normalizeTerm(
          pseudo["LeaseContractLength"] ??
            leaseRow?.defaultValue ??
            "1yr",
        )
      : "";
    const purchaseOption = reserved
      ? normalizePurchaseOption(
          pseudo["PurchaseOption"] ?? purchaseRow?.defaultValue ?? "No Upfront",
        )
      : "";

    const instanceTable = Boolean(instanceRow) && Boolean(component.calculationId?.monthly);
    const instanceSelector = instanceRow?.selectorId;
    const selectionTermType = additionalItem ? "OnDemand" : termType;
    let instanceType =
      instanceSelector ? pseudo[instanceSelector] : undefined;
    if (instanceTable && !instanceType) {
      const candidates = aggregations
        .filter(
          (entry) =>
            (!deployment ||
              entry.selectors?.["Deployment Option"] === deployment) &&
            (entry.selectors?.TermType ?? "OnDemand") === selectionTermType,
        )
        .sort((a, b) => {
          const vcpu = Number(a.selectors?.vCPU ?? 0) - Number(b.selectors?.vCPU ?? 0);
          if (vcpu !== 0) return vcpu;
          return String(a.selectors?.["Instance Type"]).localeCompare(
            String(b.selectors?.["Instance Type"]),
          );
        });
      instanceType = candidates[0]?.selectors?.[instanceSelector];
    }

    const desired = {
      [instanceSelector]: instanceType,
      "Deployment Option": deployment,
      TermType: selectionTermType,
      "Cache Engine": pseudo["Cache Engine"],
      "Instance Family": pseudo["Instance Family"],
      "Database Engine": pseudo["Database Engine"],
      LeaseContractLength: term || undefined,
      PurchaseOption: purchaseOption || undefined,
    };
    const selectorKeys = new Set([
      ...(context.meta.primarySelectors ?? []),
      ...(context.meta.secondarySelectors ?? []),
    ]);
    for (const key of Object.keys(desired)) {
      if (!selectorKeys.has(key)) delete desired[key];
    }

    for (const [selector, value] of Object.entries(pseudo)) {
      if (value != null && value !== "" && selectorKeys.has(selector)) {
        desired[selector] =
          selector === "TermType" && additionalItem
            ? selectionTermType
            : String(value);
      }
    }

    // Rows with a `dependent` parent are computed by the calculator when the
    // parent changes; only use a default when the combination exists.
    for (const row of rows) {
      const selector = row.selectorId;
      if (!selector || selector in desired || row.type === "utilization") continue;
      if (row.dependent && !row.exportValueAs) continue;
      const value = pseudo[selector] ?? row.defaultValue;
      if (value != null && value !== "" && selectorKeys.has(selector)) {
        desired[selector] = String(value);
      }
    }
    const utilizationSelector = utilizationRow?.selectorId;
    if (
      utilizationRow &&
      utilizationSelector &&
      !pseudo[utilizationSelector]
    ) {
      const raw =
        pseudo.utilization != null
          ? { unit: pseudo.utilization, selectedId: "%Utilized/Month" }
          : utilizationRow.defaultValue;
      const selectedId =
        raw && typeof raw === "object" ? raw.selectedId : undefined;
      if (selectedId && selectorKeys.has(utilizationSelector)) {
        const reverse = Object.entries(component.remap?.keyValue ?? {}).find(
          ([, display]) =>
            normalizeToken(display) === normalizeToken(selectedId),
        );
        desired[utilizationSelector] = reverse ? reverse[0] : selectedId;
      }
    }
    const remap = component.remap?.keyValue ?? {};
    const toAggregationValue = (selector, value) => {
      const reverse = Object.entries(remap).find(
        ([, display]) => normalizeToken(display) === normalizeToken(value),
      );
      return reverse ? reverse[0] : String(value);
    };
    for (const [key, value] of Object.entries(desired)) {
      desired[key] = toAggregationValue(key, value);
    }
    for (const row of rows) {
      if (!row.dependent || row.exportValueAs || !row.selectorId) continue;
      if (desired[row.selectorId] != null) continue;
      if (row.defaultValue == null || row.defaultValue === "") continue;
      const candidate = toAggregationValue(row.selectorId, row.defaultValue);
      const test = { ...desired, [row.selectorId]: candidate };
      const matches = aggregations.some((entry) =>
        Object.entries(test).every(
          ([key, value]) =>
            value == null || value === "" ||
            String(entry.selectors?.[key]) === String(value),
        ),
      );
      if (matches) desired[row.selectorId] = candidate;
    }
    const aggregation = this.selectPlcAggregation(context, desired, [
      instanceSelector,
      "Deployment Option",
      "TermType",
    ]);
    const selected = aggregation.selectors ?? {};
    if (instanceSelector && !instanceType) {
      instanceType = selected[instanceSelector];
    }
    const { data } = await loadPlcIndex(
      context,
      selected,
      this.fetchOptions,
    );
    const prices = additionalItem
      ? { hourly: 0, monthly: 0, upfront: 0, perUnit: 0, entries: [] }
      : extractPrices(
          data,
          context.display,
          {
            termType,
            term,
            purchaseOption,
            pricingUnitModel: component.pricingUnitModel,
            calculationId: component.calculationId,
          },
          rows,
        );
    if (additionalItem) {
      const additional = await this.loadAdditionalPricing(additionalItem, {
        instanceType,
        term,
        purchaseOption,
        deployment: selected["Deployment Option"] ?? deployment,
        databaseEngine:
          selected["Database Engine"] ?? pseudo["Database Engine"],
        termYears: term === "3yr" ? 3 : 1,
      });
      if (!additional) {
        throw new AxiError(
          `No ${additionalItem.name} price found for ${instanceType} in ${context.display}`,
          "VALIDATION_ERROR",
          [
            "This instance/storage combination may not be eligible for that pricing model",
            "Try another instance type or pricing model",
          ],
        );
      }
      const years = term === "3yr" ? 3 : 1;
      const fraction =
        purchaseOption === "All Upfront"
          ? 1
          : purchaseOption === "Partial Upfront"
            ? 0.5
            : 0;
      const upfront = fraction * additional.rate * commitmentHours(years);
      const effective = effectiveHourlyRate(years, additional.rate, upfront);
      prices.rate = additional.rate;
      prices.hourly = effective;
      prices.monthly = effective * 730;
      prices.upfront = upfront;
    }

    const nodes = asNumber(
      pseudo["Number of Nodes"] ??
        (nodeRow?.selectorId ? pseudo[nodeRow.selectorId] : undefined) ??
        nodeRow?.defaultValue ??
        1,
    );
    let utilizationHours = 730;
    let utilizationValue = "100";
    let utilizationUnit = "%Utilized/Month";
    if (pseudo.utilization != null) {
      const pct = Math.min(100, Math.max(0, asNumber(pseudo.utilization)));
      utilizationHours = (730 * pct) / 100;
      utilizationValue = String(pct);
    } else if (
      utilizationRow?.defaultValue &&
      typeof utilizationRow.defaultValue === "object"
    ) {
      const raw = utilizationRow.defaultValue;
      const unit = Number(raw.unit);
      const selectedId = String(raw.selectedId ?? "%Utilized/Month");
      utilizationValue = String(Number.isFinite(unit) ? unit : 730);
      utilizationUnit = selectedId;
      if (/Hours\/Day/i.test(selectedId)) {
        utilizationHours =
          (Number.isFinite(unit) ? unit : 1) * (365 / 12);
      } else {
        utilizationHours = Number.isFinite(unit) ? unit : 730;
      }
    }
    const utilization = (utilizationHours / 730) * 100;
    const runningMode = String(
      selected["Running Mode"] ?? pseudo["Running Mode"] ?? "",
    );
    const billingMode = String(
      selected.BillingOption ??
        selected["Billing Option"] ??
        pseudo.BillingOption ??
        "",
    );
    const utilizationMode = String(utilizationUnit ?? "");
    const monthlyPricing = component.pricingUnitModel?.riPricingTypes?.monthly;
    const hourlyPricing = component.pricingUnitModel?.riPricingTypes?.hourly;
    const usesMonthly =
      Boolean(monthlyPricing) &&
      !/hourly|autostop/i.test(runningMode) &&
      !/hourly/i.test(billingMode) &&
      !/hourly/i.test(utilizationMode);
    const usesHourly =
      Boolean(hourlyPricing) &&
      (/hourly|autostop/i.test(runningMode) ||
        /hourly/i.test(billingMode) ||
        /hourly/i.test(utilizationMode));
    // The PLC engine rounds monthly instance costs up to the next cent.
    const plcMonthly = (value) => Number(roundUpTo(value, 0.01).toFixed(2));
    let monthly = null;
    if (component.calculationId?.monthly) {
      if (usesMonthly) {
        monthly = plcMonthly(nodes * (prices.monthly || prices.perUnit));
      } else if (usesHourly) {
        const base = prices.monthly || 0;
        const rate = prices.hourly || 0;
        monthly = plcMonthly(nodes * (base + rate * utilizationHours));
      } else if (instanceTable) {
        monthly = plcMonthly(
          nodes * prices.hourly * (reserved ? 730 : utilizationHours),
        );
      } else if (prices.monthly || prices.perUnit) {
        monthly = plcMonthly(nodes * (prices.monthly || prices.perUnit));
      }
    }
    const upfront = roundHalfUp(
      (instanceTable ? nodes : 1) * prices.upfront,
      2,
    );

    if (monthly != null) {
      this.values.set(component.calculationId.monthly, monthly);
    }
    if (component.calculationId?.upfront) {
      this.values.set(component.calculationId.upfront, upfront);
    }
    if (!instanceTable && component.calculationId?.hourly) {
      this.values.set(component.calculationId.hourly, prices.hourly);
    }
    if (component.calculationId?.countly) {
      this.values.set(component.calculationId.countly, prices.perUnit);
    }
    for (const row of rows) {
      if (!row.exportValueAs) continue;
      if (row.selectorId === "Number of Nodes" && row.exportValueAs === "count") {
        this.values.set(row.exportValueAs, nodes);
        continue;
      }
      const raw =
        selected[row.selectorId] ??
        pseudo[row.selectorId] ??
        row.defaultValue;
      if (raw == null || raw === "") continue;
      if (row.type === "textInput" || row.type === "numericInput") {
        this.values.set(row.exportValueAs, asNumber(raw));
      } else {
        // Dropdown and auto-suggest rows export their selected value as a
        // string; the calculator references it from displayIf/operands by the
        // row's exportValueAs name (for example WorkSpaces Pools `license`).
        this.values.set(row.exportValueAs, String(raw));
      }
    }

    const exported = {
      count: nodes,
      deploymentStrategy: selected["Deployment Option"] ?? deployment,
      pricingModel: selected.TermType ?? termType,
      term: selected.LeaseContractLength ?? "",
      purchaseOption: selected.PurchaseOption ?? "",
      utilizationOut: utilization,
    };
    for (const row of rows) {
      if (row.exportValueAs && exported[row.exportValueAs] !== undefined) {
        this.values.set(row.exportValueAs, exported[row.exportValueAs]);
      }
      for (const tag of Object.values(row.exportTagsAsValue ?? {})) {
        const value = selected[tag.id];
        if (value != null) {
          this.values.set(tag.id, asNumber(value.replace(/[^\d.]/g, "")));
        }
      }
    }
    if (selected.vCPU != null) this.values.set("vCPU", asNumber(selected.vCPU));
    if (selected.Memory != null) {
      this.values.set("Memory", asNumber(String(selected.Memory).replace(/[^\d.]/g, "")));
    }

    const rowState = {};
    if (instanceTable && nodeRow) {
      rowState[nodeRow.selectorId ?? nodeRow.label ?? "Nodes"] = {
        value: String(nodes),
      };
    }
    if (instanceRow) {
      rowState[instanceRow.selectorId ?? "Instance Type"] = {
        value: String(instanceType),
      };
    }
    if (utilizationRow) {
      const key = utilizationRow.selectorId ?? "undefined";
      let selectedId = utilizationUnit;
      if (utilizationRow.selectorId === "Running Mode") {
        const mode = selected["Running Mode"] ?? pseudo["Running Mode"];
        selectedId =
          component.remap?.keyValue?.[mode] ?? utilizationUnit;
      }
      rowState[key] = {
        value: {
          unit: utilizationValue,
          selectedId,
        },
      };
    }
    if (deploymentRow) {
      rowState[deploymentRow.selectorId ?? "Deployment Option"] = {
        value: String(selected["Deployment Option"] ?? deployment),
      };
    }
    for (const row of rows) {
      if (!row.selectorId || row.selectorId === "Number of Nodes") continue;
      if (row.type === "utilization") continue;
      if (row.selectorId === "Instance Type" && !instanceTable) continue;
      let value =
        row.selectorId === "TermType" && additionalItem
          ? termType
          : selected[row.selectorId] ?? pseudo[row.selectorId];
      if (
        (value == null || value === "") &&
        (row.type === "textInput" || row.type === "numericInput") &&
        row.exportValueAs
      ) {
        value = this.values.get(row.exportValueAs);
      }
      if (value != null && value !== "") {
        rowState[row.selectorId] = {
          value: String(remap[value] ?? value),
        };
      }
    }
    if (reserved && leaseRow) {
      rowState[leaseRow.selectorId ?? "LeaseContractLength"] = {
        value: term,
      };
    }
    if (reserved && purchaseRow) {
      rowState[purchaseRow.selectorId ?? "PurchaseOption"] = {
        value: purchaseOption,
      };
    }
    this.rawInputs.set(component.id, { value: [rowState] });

    const summary = [];
    if (instanceTable && nodeRow) summary.push(`${nodeRow.label} (${nodes})`);
    if (instanceTable && instanceRow) {
      summary.push(`${instanceRow.label} (${instanceType})`);
    }
    if (instanceTable && utilizationRow) {
      summary.push(
        `${utilizationRow.label} (${utilizationValue} ${utilizationUnit})`,
      );
    }
    if (instanceTable && deploymentRow) {
      summary.push(
        `${deploymentRow.label} (${selected["Deployment Option"] ?? deployment})`,
      );
    }
    if (termTypeRow) {
      const label = additionalItem
        ? termType
        : termTypeRow.mappingValue
          ? termTypeRow.mappingValue[selected.TermType] ?? selected.TermType
          : selected.TermType ?? termType;
      summary.push(`${termTypeRow.label} (${label})`);
    }
    if (reserved && leaseRow) summary.push(`${leaseRow.label} (${term})`);
    if (reserved && purchaseRow) {
      summary.push(`${purchaseRow.label} (${purchaseOption})`);
    }
    if (!instanceTable) {
      for (const row of rows) {
        let value = selected[row.selectorId] ?? pseudo[row.selectorId];
        if (
          (value == null || value === "") &&
          (row.type === "textInput" || row.type === "numericInput") &&
          row.exportValueAs
        ) {
          value = this.values.get(row.exportValueAs);
        }
        if (value != null && value !== "") {
          summary.push(`${row.label} (${value})`);
        }
      }
    }
    this.summary.push({
      id: component.id,
      label: component.label,
      text: summary.join(", "),
    });
  }

  suppliedByLabel(component, overrides) {
    const wanted = normalizeToken(component.id);
    for (const [key, value] of Object.entries(overrides)) {
      if (normalizeToken(key) === wanted) {
        return { ...value, key };
      }
    }
    return undefined;
  }

  visibleOptions(component) {
    return (component.options ?? []).filter((option) =>
      this.evaluateCondition(option.displayIf, {}),
    );
  }

  defaultInputValue(component) {
    const subType = component.subType;
    if (subType === "dropdown") {
      const options = this.visibleOptions(component);
      const fallback =
        component.defaultDropDownItem ??
        (typeof component.defaultOption === "string"
          ? component.defaultOption
          : undefined);
      const option =
        options.find((item) => item.id === fallback) ?? options[0];
      return {
        converted: option?.id,
        raw: option ? { value: option.id } : undefined,
        display: option?.label,
        isDefault: true,
      };
    }
    if (subType === "fileSize") {
      const size =
        component.defaultOption?.size ?? component.dropDownSize?.[0]?.id ?? "gb";
      const frequency =
        component.defaultOption?.frequency ??
        component.dropDownFrequency?.[0]?.id ??
        "NA";
      if (component.defaultValue == null || component.defaultValue === "") {
        return {
          converted: 0,
          raw: undefined,
          display: null,
          isDefault: true,
        };
      }
      const value = component.defaultValue;
      return {
        converted: this.convertFileSize(value, size, frequency, component),
        raw: { value: String(value), unit: `${size}|${frequency}` },
        display: this.formatFileSize(value, size, frequency, component),
        isDefault: true,
      };
    }
    if (subType === "frequency") {
      const unit = component.defaultFrequency ?? "perMonth";
      if (component.defaultValue == null || component.defaultValue === "") {
        return {
          converted: 0,
          raw: undefined,
          display: null,
          isDefault: true,
        };
      }
      const value = component.defaultValue;
      return {
        converted: this.convertFrequencyValue(value, unit, component),
        raw: { value: String(value), unit },
        display: this.formatFrequency(value, unit, component),
        isDefault: true,
      };
    }
    if (subType === "durationInput") {
      const unit =
        component.defaultDuration ??
        component.defaultDropDownItem ??
        component.dropDownDuration?.[0]?.value ??
        component.outputDurationUnit;
      if (component.defaultValue == null || component.defaultValue === "") {
        return {
          converted: 0,
          raw: undefined,
          display: null,
          isDefault: true,
        };
      }
      const value = component.defaultValue;
      return {
        converted: this.convertDurationValue(value, unit, component),
        raw: { value: String(value), unit },
        display: this.formatDuration(value, unit, component),
        isDefault: true,
      };
    }
    if (subType === "throughput") {
      const unit =
        component.defaultThroughput ?? component.outputThroughput?.value;
      if (component.defaultValue == null || component.defaultValue === "") {
        return {
          converted: 0,
          raw: undefined,
          display: null,
          isDefault: true,
        };
      }
      const value = component.defaultValue;
      return {
        converted: this.convertThroughput(value, unit, component),
        raw: { value: String(value), unit },
        display: `${formatNumber(value)} ${component.outputThroughput?.label ?? unit}`,
        isDefault: true,
      };
    }
    if (subType === "utilization") {
      const value = component.defaultValue ?? 0;
      return {
        converted: this.convertUtilization(value, component),
        raw: { value: String(value) },
        display: String(value),
        isDefault: true,
      };
    }
    if (subType === "checkbox") {
      const value = component.defaultValue ?? false;
      return {
        converted: Boolean(value),
        raw: { value: Boolean(value) },
        display: value ? "Yes" : null,
        isDefault: true,
      };
    }
    if (subType === "percentInput") {
      const value = component.defaultValue ?? 0;
      return {
        converted: value / 100,
        raw: { value: String(value) },
        display: `${formatNumber(value)}%`,
        isDefault: true,
      };
    }
    if (NON_VALUE_INPUT.has(subType)) {
      return { converted: undefined, raw: undefined, isDefault: true };
    }
    if (component.defaultValue == null || component.defaultValue === "") {
      return {
        converted: subType === "percentInput" ? 0 : 0,
        raw: undefined,
        display: null,
        isDefault: true,
      };
    }
    const value = component.defaultValue;
    return {
      converted: value,
      raw: { value: String(value) },
      display:
        subType === "percentInput" ? `${formatNumber(value)}%` : formatNumber(value),
      isDefault: true,
    };
  }

  resolveInput(component, provided) {
    const subType = component.subType;
    if (NON_VALUE_INPUT.has(subType)) return;
    if (subType === "dataTransferV2") {
      this.resolveDataTransfer(component, provided);
      return;
    }
    if (!SUPPORTED_INPUT.has(subType)) {
      throw new AxiError(
        `Input "${component.label ?? component.id}" (${component.id}) uses unsupported control type "${subType}"`,
        "UNSUPPORTED_SERVICE",
        [
          "This service uses a calculator widget awscalc cannot model yet",
          "Try a simpler service or pin a narrower template",
        ],
      );
    }

    const fallback = this.defaultInputValue(component);
    let resolved = fallback;
    if (provided != null) {
      resolved = this.parseProvidedInput(component, provided);
    } else if (
      component.validations?.required &&
      (component.defaultValue == null || component.defaultValue === "") &&
      component.subType !== "dropdown" &&
      component.subType !== "checkbox"
    ) {
      throw new AxiError(
        `Missing required input: ${component.id} (${component.label ?? "value"})`,
        "VALIDATION_ERROR",
        [
          `Pass --set ${component.id}=<value>`,
          `Run \`awscalc service ${this.definition.serviceCode}\` for details`,
        ],
      );
    }
    this.values.set(component.id, resolved.converted);
    if (resolved.raw) this.rawInputs.set(component.id, resolved.raw);
    if (component.displayInConfigSummary && resolved.display != null) {
      this.summary.push({
        id: component.id,
        label: component.label,
        text: `${component.label} (${resolved.display})`,
      });
    }
    return resolved;
  }

  resolveDataTransfer(component, provided) {
    const map = this.maps.get(component.mappingDefinitionName);
    const raw = provided?.value ?? provided?.text ?? "";
    const entries = parseDataTransferEntries(raw, this.displayRegion);
    if (entries.length === 0) {
      this.values.set(component.id, 0);
      return;
    }
    if (!map) {
      throw new AxiError(
        `Data transfer pricing is unavailable for ${component.id}`,
        "UNSUPPORTED_SERVICE",
        ["The calculator has no data transfer map for this service in this region"],
      );
    }
    const clean = (value) =>
      String(value)
        .replace(/[().,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const tierPrices = Object.entries(map.data)
      .filter(([key, entry]) => {
        const start = Number(entry?.StartingRange);
        const end = entry?.EndingRange;
        return (
          key.startsWith("DataTransfer External Outbound") &&
          Number.isFinite(start) &&
          (end != null)
        );
      })
      .map(([key, entry]) => ({
        key,
        start: Number(entry.StartingRange),
        end: /inf/i.test(String(entry.EndingRange))
          ? Infinity
          : Number(entry.EndingRange),
        price: Number(entry.price) || 0,
      }))
      .sort((a, b) => a.start - b.start);

    let total = 0;
    const state = [];
    for (const entry of entries) {
      const option = entry.optionType == null ? "" : String(entry.optionType).trim();
      if (option && !/^(standard|default|none)$/i.test(option)) {
        throw new AxiError(
          `Data transfer option "${option}" is not supported`,
          "UNSUPPORTED_SERVICE",
          [
            "Accelerated transfer is not published in the calculator's data transfer pricing maps",
            "Use standard inbound, intra-region, outbound, or inter-region transfer",
          ],
        );
      }
      let cost = 0;
      if (entry.entryType === "INBOUND") {
        cost = 0;
      } else if (entry.entryType === "INTRA_REGION") {
        const price = map.priceFor("DataTransfer IntraRegion") ?? 0;
        // The calculator charges both directions for intra-region traffic.
        cost = price * entry.gb * 2;
      } else if (entry.toRegion && !/^(external|other)$/i.test(entry.toRegion)) {
        const display = regionName(entry.toRegion) ?? entry.toRegion;
        const key = `DataTransfer InterRegion Outbound to ${clean(display)}`;
        const price = map.priceFor(key);
        if (price == null) {
          this.warning(
            `No inter-region outbound price for ${display} in ${this.displayRegion}`,
          );
          cost = 0;
        } else {
          cost = price * entry.gb;
        }
      } else if (tierPrices.length > 0) {
        for (const tier of tierPrices) {
          const end = Number.isFinite(tier.end) ? tier.end : entry.gb;
          const used = Math.max(Math.min(entry.gb, end) - tier.start, 0);
          if (used > 0) cost += used * tier.price;
        }
      } else {
        cost = (map.priceFor("DataTransfer External Outbound") ?? 0) * entry.gb;
      }
      total += cost;
      state.push({
        entryType: entry.entryType,
        value: entry.gb,
        unit: "gb_month",
        ...(entry.fromRegion ? { fromRegion: entry.fromRegion } : {}),
        ...(entry.toRegion ? { toRegion: entry.toRegion } : {}),
        ...(entry.optionType ? { optionType: entry.optionType } : {}),
      });
    }
    const amount = roundHalfUp(total, 2);
    this.values.set(component.id, amount);
    this.rawInputs.set(component.id, { value: state });
    if (component.displayInConfigSummary !== false) {
      const labels = {
        INBOUND: "Inbound",
        INTRA_REGION: "Intra-Region",
        OUTBOUND: "Outbound",
      };
      const parts = entries.map((entry) => {
        const region = entry.toRegion ?? entry.fromRegion;
        return `${labels[entry.entryType] ?? entry.entryType}: ${formatNumber(
          entry.value,
        )} TB per month${region ? ` (${region})` : ""}`;
      });
      this.summary.push({
        id: component.id,
        label: component.label ?? "Data Transfer",
        text: `Data Transfer (${parts.join(", ")})`,
      });
    }
  }

  resolveFileSizeFrequency(component, unitText) {
    if (!unitText) return null;
    const wanted = normalizeToken(unitText);
    const options = component.dropDownFrequency ?? [];
    const byId = options.find((option) => normalizeToken(option.id) === wanted);
    if (byId) return byId.id;
    const byLabel = options.find(
      (option) => normalizeToken(option.label) === wanted,
    );
    if (byLabel) return byLabel.id;
    const alias = {
      persecond: "second",
      perminute: "minute",
      perhour: "hour",
      perday: "day",
      perweek: "week",
      permonth: "month",
      peryear: "year",
      second: "second",
      minute: "minute",
      hour: "hour",
      day: "day",
      week: "week",
      month: "month",
      year: "year",
    }[wanted];
    if (alias && options.some((option) => option.id === alias)) return alias;
    return null;
  }

  resolveFrequencyOption(component, unitText) {
    if (!unitText) return null;
    const wanted = normalizeToken(unitText);
    const options = component.options ?? [];
    const byId = options.find((option) => normalizeToken(option.id) === wanted);
    if (byId) return byId.id;
    const byLabel = options.find(
      (option) => normalizeToken(option.label) === wanted,
    );
    if (byLabel) return byLabel.id ?? byLabel.value;
    return null;
  }

  parseProvidedInput(component, provided) {
    const subType = component.subType;
    const text = provided.text ?? provided.value ?? "";
    const parsed = splitValueAndUnit(text);

    if (subType === "dropdown") {
      const options = this.visibleOptions(component);
      const wanted = normalizeToken(parsed.unit ? `${parsed.value}${parsed.unit}` : text);
      const option =
        options.find((item) => normalizeToken(item.id) === wanted) ??
        options.find((item) => normalizeToken(item.label) === wanted) ??
        options.find(
          (item) =>
            normalizeToken(item.label).includes(wanted) && wanted.length > 0,
        );
      if (!option) {
        throw new AxiError(
          `Invalid value "${text}" for ${component.id}`,
          "VALIDATION_ERROR",
          [
            `Valid values: ${options
              .map((item) => `${item.id} (${item.label})`)
              .join(", ")}`,
          ],
        );
      }
      return {
        converted: option.id,
        raw: { value: option.id },
        display: option.label,
        isDefault: false,
      };
    }

    if (subType === "fileSize") {
      let size = parsed.value;
      let sizeUnit =
        parseSizeUnit(parsed.unit) ??
        parseSizeUnit(parsed.unit.split(/[\s/]+/)[0]) ??
        component.defaultOption?.size ??
        component.dropDownSize?.[0]?.id ??
        "gb";
      let frequency = "NA";
      const freqPart = parsed.unit
        .split(/[\s/]+/)
        .slice(1)
        .join(" ");
      const explicitFreq =
        this.resolveFileSizeFrequency(component, freqPart) ??
        parseFrequencyUnit(freqPart);
      if (explicitFreq) frequency = explicitFreq;
      else if (component.dropDownFrequency?.length) {
        frequency =
          component.defaultOption?.frequency ??
          component.dropDownFrequency[0]?.id ??
          "NA";
      }
      const convertedFileSize = this.convertFileSize(
        size,
        sizeUnit,
        frequency,
        component,
      );
      this.validateInput(component, convertedFileSize);
      return {
        converted: convertedFileSize,
        raw: { value: String(size), unit: `${sizeUnit}|${frequency}` },
        display: this.formatFileSize(size, sizeUnit, frequency, component),
        isDefault: false,
      };
    }

    if (subType === "frequency") {
      const options = component.options ?? [];
      const matched = this.resolveFrequencyOption(component, parsed.unit);
      if (parsed.unit && options.length > 0 && !matched) {
        throw new AxiError(
          `Invalid unit "${parsed.unit}" for ${component.id}`,
          "VALIDATION_ERROR",
          [
            `Valid units: ${options
              .map((option) => option.label)
              .join(", ")}`,
            component.defaultFrequency
              ? `Default: ${component.defaultFrequency}`
              : undefined,
          ].filter(Boolean),
        );
      }
      const unit =
        matched ??
        (options.length === 0 ? parseFrequencyUnit(parsed.unit) : null) ??
        component.defaultFrequency ??
        "perMonth";
      const convertedFrequency = this.convertFrequencyValue(
        parsed.value,
        unit,
        component,
      );
      this.validateInput(component, parsed.value);
      return {
        converted: convertedFrequency,
        raw: { value: String(parsed.value), unit },
        display: this.formatFrequency(parsed.value, unit, component),
        isDefault: false,
      };
    }

    if (subType === "durationInput") {
      const unit =
        parseTimeUnit(parsed.unit) ??
        component.defaultDuration ??
        component.dropDownDuration?.[0]?.value ??
        component.outputDurationUnit;
      const convertedDuration = this.convertDurationValue(
        parsed.value,
        unit,
        component,
      );
      this.validateInput(component, convertedDuration);
      return {
        converted: convertedDuration,
        raw: { value: String(parsed.value), unit },
        display: this.formatDuration(parsed.value, unit, component),
        isDefault: false,
      };
    }

    if (subType === "throughput") {
      const unit =
        parsed.unit?.toLowerCase().replace(/ibps|bps/, "bps") ||
        component.defaultThroughput;
      const convertedThroughput = this.convertThroughput(
        parsed.value,
        unit,
        component,
      );
      this.validateInput(component, convertedThroughput);
      return {
        converted: convertedThroughput,
        raw: { value: String(parsed.value), unit },
        display: `${formatNumber(parsed.value)} ${component.outputThroughput?.label ?? unit}`,
        isDefault: false,
      };
    }

    if (subType === "utilization") {
      this.validateInput(component, parsed.value);
      return {
        converted: this.convertUtilization(parsed.value, component),
        raw: { value: String(parsed.value) },
        display: `${formatNumber(parsed.value)} ${component.defaultDuration === "percentagePerMonth" ? "%" : "hours"}`,
        isDefault: false,
      };
    }

    if (subType === "checkbox") {
      const truthy = /^(true|yes|y|1|on|enabled)$/i.test(text);
      const falsy = /^(false|no|n|0|off|disabled)$/i.test(text);
      if (!truthy && !falsy) {
        throw new AxiError(
          `Invalid boolean "${text}" for ${component.id}`,
          "VALIDATION_ERROR",
          ["Use true/false"],
        );
      }
      const value = truthy;
      return {
        converted: value,
        raw: { value },
        display: value ? "Yes" : "No",
        isDefault: false,
      };
    }

    if (subType === "percentInput") {
      this.validateInput(component, parsed.value);
      return {
        converted: parsed.value / 100,
        raw: { value: String(parsed.value) },
        display: `${formatNumber(parsed.value)}%`,
        isDefault: false,
      };
    }

    this.validateInput(component, parsed.value);
    return {
      converted: parsed.value,
      raw: { value: String(parsed.value) },
      display:
        component.subType === "numericInput"
          ? formatNumber(parsed.value)
          : formatNumber(parsed.value),
      isDefault: false,
    };
  }

  validateInput(component, value) {
    const rules = component.validations ?? {};
    if (!Number.isFinite(value)) {
      throw new AxiError(
        `Invalid number for ${component.id}`,
        "VALIDATION_ERROR",
        [`Expected a number, received "${value}"`],
      );
    }
    if (rules.minValue != null && value < rules.minValue) {
      throw new AxiError(
        `${component.id} must be at least ${rules.minValue}`,
        "VALIDATION_ERROR",
        [`You provided ${value}`],
      );
    }
    if (rules.maxValue != null && value > rules.maxValue) {
      throw new AxiError(
        `${component.id} must be at most ${rules.maxValue}`,
        "VALIDATION_ERROR",
        [`You provided ${value}`],
      );
    }
  }

  convertFileSize(value, sizeUnit, frequency, component) {
    const inSize = convertSize(
      value,
      sizeUnit,
      component.outputSize ?? sizeUnit,
    );
    const outputFrequency = component.outputFrequency;
    if (
      outputFrequency &&
      outputFrequency !== "NA" &&
      frequency &&
      frequency !== "NA" &&
      frequency !== outputFrequency
    ) {
      // fileSize frequencies are time units ("hour", "month", ...): convert the
      // amount per unit time into the amount per output unit time.
      return convertDuration(inSize, outputFrequency, frequency);
    }
    return inSize;
  }

  convertFrequencyValue(value, unit, component) {
    const output =
      component.outputFrequency?.id ??
      component.outputFrequency?.value ??
      component.outputFrequency;
    if (!output || output === "NA" || typeof output !== "string") return value;
    return roundHalfUp(
      convertFrequency(value, unit, output),
      component.decimalPlaces || 2,
    );
  }

  convertThroughput(value, unit, component) {
    const output = component.outputThroughput?.value;
    if (!unit || !output || unit === output) return value;
    const factors = { kbps: 1, mbps: 1024, gbps: 1024 * 1024 };
    if (!factors[unit] || !factors[output]) return value;
    return (value * factors[unit]) / factors[output];
  }

  convertDurationValue(value, unit, component) {
    if (!unit || unit === component.outputDurationUnit) return value;
    return ceilTo(
      convertDuration(value, unit, component.outputDurationUnit),
      component.outputDecimalPlaces || 2,
    );
  }

  convertUtilization(value, component) {
    if (component.defaultDuration === undefined) return value;
    let hours;
    if (component.defaultDuration === "percentagePerMonth") {
      hours = (value / 100) * 730;
    } else {
      hours = value;
    }
    if (component.roundUpToHours) hours = Math.ceil(hours);
    return hours;
  }

  formatFileSize(value, sizeUnit, frequency, component) {
    const sizeLabel =
      component.dropDownSize?.find((item) => item.id === sizeUnit)?.label ??
      SIZE_LABEL[sizeUnit] ??
      sizeUnit;
    let text = `${formatNumber(value)} ${sizeLabel}`;
    if (frequency && frequency !== "NA") {
      const freqLabel =
        component.dropDownFrequency?.find((item) => item.id === frequency)
          ?.label ?? FREQ_LABEL[frequency]?.replace(/^per /, "");
      text += ` per ${freqLabel}`;
    }
    return text;
  }

  formatFrequency(value, unit, component) {
    const label =
      component.options?.find((item) => (item.value ?? item.id) === unit)
        ?.label ?? FREQ_LABEL[unit] ?? unit;
    return `${formatNumber(value)} ${label}`;
  }

  formatDuration(value, unit, component) {
    const label =
      component.dropDownDuration?.find(
        (item) => (item.value ?? item.id) === unit,
      )?.label ?? unit;
    return `${formatNumber(value)} ${label}`;
  }

  resolvePricing(component) {
    const subType = component.subType;
    if (!SUPPORTED_PRICING.has(subType)) {
      throw new AxiError(
        `${this.definition.serviceName?.trim() ?? "This service"} uses pricing feature "${subType}", which awscalc cannot model yet`,
        "UNSUPPORTED_SERVICE",
        ["Try a service whose pricing uses standard metered-unit tables"],
      );
    }
    if (subType === "replace") {
      const original = this.resolvePricingReference({
        variableId: component.originalId,
      });
      const hit = (component.replacements ?? []).find(
        (replacement) => replacement.originalString === String(original),
      );
      const value = hit?.replaceString ?? String(original ?? "");
      this.pricingValues.set(component.id, { kind: subType, value });
      this.values.set(component.id, value);
      return;
    }

    if (subType === "concatenate") {
      const value = (component.operands ?? [])
        .map((operand) => {
          if ("constant" in operand) return String(operand.constant);
          return String(this.resolvePricingReference(operand) ?? "");
        })
        .join("");
      this.pricingValues.set(component.id, { kind: subType, value });
      this.values.set(component.id, value);
      return;
    }

    if (
      component.mappingDefinitionName &&
      this.unsupportedMappings.has(component.mappingDefinitionName)
    ) {
      throw new AxiError(
        `Pricing for ${this.definition.serviceName?.trim() ?? "this service"} uses calculator data awscalc cannot read yet`,
        "UNSUPPORTED_SERVICE",
        [
          "The service relies on advanced (PLC 2.0) pricing tables",
          "Try S3, Lambda, DynamoDB, CloudFront, EBS, or another listed service",
        ],
      );
    }

    const map = this.maps.get(component.mappingDefinitionName);
    if (!map) {
      if (component.displayIf) return;
      this.warning(
        `No pricing map "${component.mappingDefinitionName}" for ${component.id}`,
      );
      this.pricingValues.set(component.id, { kind: subType, missing: true });
      return;
    }

    if (subType === "singlePricePoint") {
      const unit = this.selectMeteredUnit(component);
      const zeroCost = typeof unit === "string" && /^\[.*COST\]$/.test(unit);
      let price = zeroCost ? 0 : map.priceFor(unit);
      if (price == null) {
        this.warning(
          `${component.label ?? component.id}: no price for "${unit}" in ${this.displayRegion}`,
        );
        if (component.backwardCompatibility?.hideCardWhenMissing !== false) {
          this.pricingValues.set(component.id, {
            kind: subType,
            unit,
            missing: true,
          });
          return;
        }
        price = 0;
      }
      this.pricingValues.set(component.id, { kind: subType, unit, price });
      this.values.set(component.id, price);
      return;
    }

    if (subType === "pricingComboV2") {
      const refers = component.refers ?? [];
      const unit = this.resolvePricingReference(refers[0]);
      const key = refers[0]?.key;
      const zeroCost = typeof unit === "string" && /^\[.*COST\]$/.test(unit);
      const entry = zeroCost ? 0 : map.entryFor(unit);
      let price = zeroCost ? 0 : null;
      if (entry != null) {
        if (key) {
          const nested = entry[key];
          if (typeof nested === "number") price = nested;
          else if (typeof nested === "string") price = Number(nested);
          else if (nested && typeof nested.price !== "undefined") {
            price = Number(nested.price);
          }
        } else if (typeof entry === "number") {
          price = entry;
        } else if (typeof entry.price !== "undefined") {
          price = Number(entry.price);
        }
      }
      if (price != null && Number.isFinite(price)) {
        this.pricingValues.set(component.id, { kind: subType, unit, price });
        this.values.set(component.id, price);
      } else {
        this.warning(
          `${component.label ?? component.id}: no price for "${unit}" in ${this.displayRegion}`,
        );
        this.pricingValues.set(component.id, {
          kind: subType,
          unit,
          missing: true,
        });
        this.values.set(component.id, 0);
      }
      return;
    }

    if (subType === "tieredPricing") {
      const tiersRaw =
        component.tiers?.[this.displayRegion] ??
        component.tiers?.allRegions ??
        [];
      const allTiers = tiersRaw.map((tier) => ({
        start: Number(tier.startOfTier) || 0,
        end: tier.endOfTier === -1 ? Infinity : Number(tier.endOfTier),
        unit: tier.meteredUnit,
        price: map.priceFor(tier.meteredUnit),
      }));
      const tiers = allTiers
        .filter((tier) => tier.price != null)
        .sort((a, b) => a.start - b.start);
      const missingTiers = allTiers.length - tiers.length;
      if (missingTiers > 0) {
        this.warning(
          `${component.label ?? component.id}: ${missingTiers} of ${allTiers.length} tier prices are unavailable in ${this.displayRegion}`,
        );
      }
      this.pricingValues.set(component.id, { kind: subType, tiers });
      return;
    }

  }

  resolvePricingReference(operand) {
    if (!operand) return undefined;
    if ("constant" in operand) return String(operand.constant);
    if (operand.variableId) {
      if (this.pricingValues.has(operand.variableId)) {
        return this.pricingValues.get(operand.variableId).value;
      }
      if (this.values.has(operand.variableId)) {
        return this.values.get(operand.variableId);
      }
      const component = this.findComponent(operand.variableId);
      if (component) {
        if (component.type === "pricing") this.resolvePricing(component);
        else if (component.type === "input") {
          const fallback = this.defaultInputValue(component);
          return fallback.converted;
        }
        if (this.pricingValues.has(component.id)) {
          return this.pricingValues.get(component.id).value;
        }
        return this.values.get(component.id);
      }
    }
    return operand.value;
  }

  selectMeteredUnit(component) {
    const units = component.meteredUnit;
    if (typeof units === "string") return units;
    if (!units) return undefined;
    return units[this.displayRegion] ?? units.allRegions;
  }

  operandMissing(operand) {
    if (!operand?.variableId) return false;
    return (
      !this.values.has(operand.variableId) &&
      !this.pricingValues.has(operand.variableId)
    );
  }

  operandValue(operand) {
    if (operand == null) return 0;
    if ("constant" in operand) return asNumber(operand.constant);
    if (operand.variableId) {
      if (!this.values.has(operand.variableId)) {
        const component = this.findComponent(operand.variableId);
        if (component?.type === "pricing") this.resolvePricing(component);
      }
      if (this.values.has(operand.variableId)) {
        return asNumber(this.values.get(operand.variableId));
      }
      return 0;
    }
    return 0;
  }

  evaluateMath(component) {
    if (component.subType === "ec2AdvPricingStrategyMath") {
      return this.values.get(component.id) ?? {};
    }
    if (
      component.subType === "workloadInstanceMath" ||
      component.subType === "workloadStorageMath" ||
      component.subType === "dedicatedHostsMath"
    ) {
      return this.values.get(component.id) ?? {};
    }
    if (!SUPPORTED_MATH.has(component.subType)) {
      throw new AxiError(
        `${this.definition.serviceName?.trim() ?? "This service"} uses calculation feature "${component.subType}", which awscalc cannot model yet`,
        "UNSUPPORTED_SERVICE",
        ["Try a service whose formulas use standard arithmetic and tier pricing"],
      );
    }
    let result = 0;
    if (component.subType === "variable") {
      const target = component.refer ?? component.operands?.[0]?.variableId;
      result = target ? asNumber(this.values.get(target)) : 0;
    } else if (component.subType === "basicMaths") {
      const missingRequired = (component.operands ?? []).some(
        (operand) => operand.required && this.operandMissing(operand),
      );
      const operands = (component.operands ?? []).map((operand) =>
        this.operandValue(operand),
      );
      if (missingRequired) {
        result = 0;
      } else switch (component.operation) {
        case "multiplication":
          result = operands.reduce((acc, value) => acc * value, 1);
          break;
        case "addition":
          result = operands.reduce((acc, value) => acc + value, 0);
          break;
        case "subtraction":
          result = operands.length
            ? operands.slice(1).reduce((acc, value) => acc - value, operands[0])
            : 0;
          break;
        case "division":
          result = operands.length
            ? operands.slice(1).reduce((acc, value) => {
                if (!value) return 0;
                return acc / value;
              }, operands[0])
            : 0;
          break;
        case "exponent":
          result = operands.length >= 2 ? operands[0] ** operands[1] : 0;
          break;
        default:
          result = operands[0] ?? 0;
      }
      if (component.minValue != null && result < component.minValue) {
        result = component.minValue;
      }
    } else if (component.subType === "maxMin") {
      if (
        (component.operands ?? []).some(
          (operand) => operand.required && this.operandMissing(operand),
        )
      ) {
        result = 0;
      } else {
        const operands = (component.operands ?? []).map((operand) =>
          this.operandValue(operand),
        );
        result =
          component.operation === "Minimum"
            ? Math.min(...operands)
            : Math.max(...operands);
      }
    } else if (component.subType === "rounding") {
      const operand = component.operands?.[0];
      const value = this.operandValue(operand);
      const factor = asNumber(component.factor ?? 1) || 1;
      const method = component.method ?? "roundUp";
      if (operand?.required && this.operandMissing(operand)) result = 0;
      else if (method === "roundUp") result = roundUpTo(value, factor);
      else if (method === "roundDown") result = roundDownTo(value, factor);
      else if (method === "round") result = roundHalfUp(value / factor) * factor;
      else result = value;
    } else if (component.subType === "tieredPricingMath") {
      const amount = this.operandMissing({ variableId: component.inputRefer })
        ? 0
        : this.operandValue({ variableId: component.inputRefer });
      const pricing = this.pricingValues.get(component.tieredPricingRefer);
      result = this.tieredCost(amount, pricing);
    } else if (component.subType === "snapShotMaths") {
      const named = {};
      for (const operand of component.operands ?? []) {
        if (operand.operand) {
          named[operand.operand] = this.operandValue({
            variableId: operand.variableId,
          });
        }
      }
      const storage = named.ebsStorage ?? 0;
      const changed = named.amountSnapShotChanged ?? 0;
      const frequency = named.snapShotFrequency ?? 0;
      const price = named.snapShotPricing ?? 0;
      if (!storage || !changed || Number(frequency) === 0) {
        result = 0;
      } else {
        const initial = storage * price;
        const perSnapshot = changed * price;
        result = initial + (perSnapshot / 2) * frequency;
      }
    }

    if (component.decimalPlaces) {
      result = roundHalfUp(result, component.decimalPlaces);
    }
    this.values.set(component.id, result);
    this.trace.push({
      id: component.id,
      type: component.subType,
      operation: component.operation,
      value: result,
      label:
        component.outputUnitLabel ??
        component.variableName ??
        component.label ??
        null,
    });
    return result;
  }

  tieredCost(amount, pricing) {
    if (!pricing || !Array.isArray(pricing.tiers) || pricing.tiers.length === 0) {
      return 0;
    }
    const usage = Math.max(0, asNumber(amount));
    const tiers = pricing.tiers;
    let total = 0;
    tiers.forEach((tier, index) => {
      let units;
      if (index === 0) {
        const span = Number.isFinite(tier.end)
          ? tier.end - tier.start
          : Infinity;
        units = Math.max(Math.min(span, usage), 0);
      } else {
        const previousEnd = tiers[index - 1].end;
        units = Number.isFinite(tier.end)
          ? Math.max(Math.min(tier.end - previousEnd, usage - previousEnd), 0)
          : Math.max(usage - previousEnd, 0);
      }
      if (units > 0) total += units * tier.price;
    });
    return total;
  }

  evaluate() {
    for (const card of this.cards()) {
      if (!this.cardIsVisible(card)) continue;
      for (const group of card.mathsSection ?? []) {
        for (const component of group.components ?? []) {
          if (!this.evaluateCondition(component.displayIf, {})) continue;
          if (component.type === "pricing") {
            this.resolvePricing(component);
            continue;
          }
          if (component.type !== "maths") continue;
          if (component.subType === "variable") {
            this.evaluateMath(component);
            continue;
          }
          this.evaluateMath(component);
        }
      }
      for (const component of [
        ...(card.mathsSection ?? []).flatMap((group) => group.components ?? []),
      ]) {
        if (
          component.subType !== "priceDisplay" &&
          component.subType !== "ec2PriceDisplay"
        ) {
          continue;
        }
        if (!this.evaluateCondition(component.displayIf, {})) continue;
        let amount;
        if (component.subType === "ec2PriceDisplay") {
          const source = this.values.get(component.refer);
          amount = asNumber(source?.[component.path]);
        } else {
          amount = asNumber(
            this.values.get(component.subTotalRefer) ??
              this.operandValue({ variableId: component.subTotalRefer }),
          );
        }
        this.costLines.push({
          id: component.id,
          label: component.label ?? "Cost",
          costType: component.costType ?? "Monthly",
          amount,
          card: card.title ?? null,
        });
      }
    }

    const monthly = roundHalfUp(
      this.costLines
        .filter((line) => line.costType !== "Upfront")
        .reduce((acc, line) => acc + line.amount, 0),
      2,
    );
    const upfront = roundHalfUp(
      this.costLines
        .filter((line) => line.costType === "Upfront")
        .reduce((acc, line) => acc + line.amount, 0),
      2,
    );

    const summary = dedupeSummary(this.summary)
      .map((item) => item.text)
      .join(", ");

    return {
      monthly,
      upfront,
      total12Months: roundHalfUp(monthly * 12 + upfront, 2),
      summary,
      costLines: this.costLines.filter((line) => line.amount !== 0),
      warnings: this.warnings,
      calculationComponents: this.calculationComponents(),
      trace: this.trace,
    };
  }

  calculationComponents() {
    // The calculator's rehydration path expects every visible input with a
    // value, including defaults. Omitting them makes "Update estimate" treat
    // the field as empty (and can zero out the recomputed total).
    const components = {};
    for (const [id, raw] of this.rawInputs) {
      components[id] = raw;
    }
    return components;
  }
}

function dedupeSummary(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.text)) return false;
    seen.add(item.text);
    return true;
  });
}

export function selectTemplate(definition, templateId) {
  const templates = (definition?.templates ?? []).filter(
    (template) => template && typeof template === "object",
  );
  if (definition?.subType === "subServiceSelector") {
    throw new AxiError(
      `${definition.serviceName} is a service group in the calculator`,
      "UNSUPPORTED_SERVICE",
      [
        "Choose one of its sub-services instead, for example `--service amazonS3Standard`",
        "Run `awscalc services --all --filter s3` to see available codes",
      ],
    );
  }
  if (templates.length === 0) {
    throw new AxiError(
      `${definition?.serviceName ?? "Service"} has no configurable templates`,
      "UNSUPPORTED_SERVICE",
    );
  }
  if (!templateId) return templates[0];
  const wanted = String(templateId).toLowerCase();
  const hit = templates.find(
    (template) =>
      template.id?.toLowerCase() === wanted ||
      template.title?.toLowerCase() === wanted,
  );
  if (!hit) {
    throw new AxiError(`Unknown template: ${templateId}`, "VALIDATION_ERROR", [
      `Available templates: ${templates
        .map((template) => `${template.id} (${template.title})`)
        .join(", ")}`,
    ]);
  }
  return hit;
}

export function supportedSurface(definition) {
  const unsupportedMath = new Set();
  const unsupportedPricing = new Set();
  const unsupportedInput = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "maths" && !SUPPORTED_MATH.has(value.subType)) {
      unsupportedMath.add(value.subType);
    }
    if (value.type === "pricing" && !SUPPORTED_PRICING.has(value.subType)) {
      unsupportedPricing.add(value.subType);
    }
    if (value.type === "input" && !SUPPORTED_INPUT.has(value.subType)) {
      unsupportedInput.add(value.subType);
    }
    Object.values(value).forEach(walk);
  };
  walk(definition?.templates ?? []);
  return {
    unsupportedMath: [...unsupportedMath],
    unsupportedPricing: [...unsupportedPricing],
    unsupportedInput: [...unsupportedInput],
  };
}
