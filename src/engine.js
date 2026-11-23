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

const SUPPORTED_MATH = new Set([
  "basicMaths",
  "variable",
  "rounding",
  "maxMin",
  "tieredPricingMath",
  "snapShotMaths",
]);

const SUPPORTED_PRICING = new Set([
  "singlePricePoint",
  "pricingComboV2",
  "tieredPricing",
  "replace",
  "concatenate",
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
]);

const NON_VALUE_INPUT = new Set([
  "alert",
  "bodyText",
  "headerText",
  "condition",
]);

// CLI aliases for the single row of a columnFormIPM instance table.
const COLUMN_ROW_ALIASES = {
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
    let columnIndex = 0;
    const hasColumnForm = this.cards().some((card) =>
      (card.inputSection?.components ?? []).some(
        (component) => component.subType === "columnFormIPM",
      ),
    );
    for (const card of this.cards()) {
      if (!this.cardIsVisible(card)) continue;
      const components = card.inputSection?.components ?? [];
      for (const component of components) {
        if (!this.evaluateCondition(component.displayIf, {})) continue;
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
          /^(?:instanceType|nodes|deployment|pricingModel|term|purchaseOption|utilization)\d*$/.test(
            id,
          )
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

  /** Resolve a columnFormIPM instance table row via the PLC 2.0 price index. */
  async resolveColumnFormIPM(component, pseudo = {}, index = 1) {
    const rows = component.row ?? [];
    const bySelector = (selector) =>
      rows.find((row) => row.selectorId === selector);
    const byExport = (name) =>
      rows.find((row) => row.exportValueAs === name);
    const nodeRow = byExport("count") ?? bySelector("Number of Nodes");
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
    const reserved = /reserved/i.test(String(termType));
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
          "Database Savings Plans / other commitment models are not implemented",
        ],
      );
    }
    const term = reserved
      ? normalizeTerm(
          pseudo["LeaseContractLength"] ?? leaseRow?.defaultValue ?? "1yr",
        )
      : "";
    const purchaseOption = reserved
      ? normalizePurchaseOption(
          pseudo["PurchaseOption"] ?? purchaseRow?.defaultValue ?? "No Upfront",
        )
      : "";

    const instanceTable = Boolean(instanceRow) && Boolean(component.calculationId?.monthly);
    const instanceSelector = instanceRow?.selectorId;
    let instanceType =
      instanceSelector ? pseudo[instanceSelector] : undefined;
    if (instanceTable && !instanceType) {
      const candidates = aggregations
        .filter(
          (entry) =>
            (!deployment ||
              entry.selectors?.["Deployment Option"] === deployment) &&
            (entry.selectors?.TermType ?? "OnDemand") === termType,
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
      TermType: termType,
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
    const aggregation = selectAggregation(context, desired);
    const selected = aggregation.selectors ?? {};
    const { data } = await loadPlcIndex(
      context,
      selected,
      this.fetchOptions,
    );
    const prices = extractPrices(
      data,
      context.display,
      { termType, term, purchaseOption },
      rows,
    );

    const nodes = asNumber(
      pseudo["Number of Nodes"] ?? nodeRow?.defaultValue ?? 1,
    );
    const utilization = Math.min(
      100,
      Math.max(
        0,
        asNumber(
          pseudo.utilization ??
            utilizationRow?.defaultValue ??
            100,
        ),
      ),
    );
    const monthly =
      instanceTable && component.calculationId?.monthly
        ? roundHalfUp(
            nodes *
              prices.hourly *
              730 *
              (reserved ? 1 : utilization / 100),
            2,
          )
        : null;
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
      if (row.type !== "textInput" && row.type !== "numericInput") continue;
      if (!row.exportValueAs) continue;
      const value = asNumber(
        pseudo[row.selectorId] ?? row.defaultValue ?? 0,
      );
      this.values.set(row.exportValueAs, value);
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
      rowState.undefined = {
        value: {
          unit: String(utilization),
          selectedId: "%Utilized/Month",
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
      if (row.selectorId === "Instance Type" && !instanceTable) continue;
      const value = selected[row.selectorId] ?? pseudo[row.selectorId];
      if (value != null && value !== "") {
        rowState[row.selectorId] = { value: String(value) };
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
        `${utilizationRow.label} (${formatNumber(utilization)} %Utilized/Month)`,
      );
    }
    if (instanceTable && deploymentRow) {
      summary.push(
        `${deploymentRow.label} (${selected["Deployment Option"] ?? deployment})`,
      );
    }
    if (termTypeRow) {
      const label = termTypeRow.mappingValue
        ? termTypeRow.mappingValue[selected.TermType] ?? selected.TermType
        : selected.TermType ?? termType;
      summary.push(`${termTypeRow.label} (${label})`);
    }
    if (reserved && leaseRow) summary.push(`${leaseRow.label} (${term})`);
    if (reserved && purchaseRow) {
      summary.push(`${purchaseRow.label} (${purchaseOption})`);
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
    if (!SUPPORTED_INPUT.has(subType)) {
      if (subType === "dataTransferV2" && !provided) {
        this.warning(`Skipped optional data transfer input ${component.id}`);
        this.values.set(component.id, 0);
        return;
      }
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
        if (component.subType !== "priceDisplay") continue;
        if (!this.evaluateCondition(component.displayIf, {})) continue;
        const amount = asNumber(
          this.values.get(component.subTotalRefer) ??
            this.operandValue({ variableId: component.subTotalRefer }),
        );
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
