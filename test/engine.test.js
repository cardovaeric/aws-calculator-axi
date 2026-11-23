import assert from "node:assert/strict";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import {
  Engine,
  parseDataTransferEntries,
  parseDedicatedHosts,
  selectTemplate,
  supportedSurface,
} from "../src/engine.js";
import { regionName } from "../src/regions.js";

function mapWith(units) {
  const data = Object.fromEntries(
    Object.entries(units).map(([name, price]) => [name, { price: String(price) }]),
  );
  const map = {
    name: "test",
    currency: "USD",
    region: "US East (N. Virginia)",
    units: new Set(Object.keys(data)),
    data,
    priceFor(unit) {
      return unit && data[unit] ? Number(data[unit].price) : null;
    },
    entryFor(unit) {
      return data[unit];
    },
  };
  return new Map([["test", map]]);
}

function definition({ cards, mappingDefinitions = [] } = {}) {
  return {
    version: "1.0.0",
    serviceName: "Test Service",
    serviceCode: "testService",
    mappingDefinitions,
    templates: [{ id: "main", title: "Main", cards }],
  };
}

function storageCard(extra = {}) {
  return {
    title: "Storage",
    inputSection: {
      components: [
        {
          type: "input",
          subType: "fileSize",
          id: "storage",
          label: "Storage",
          dropDownSize: [
            { id: "gb", label: "GB" },
            { id: "tb", label: "TB" },
          ],
          dropDownFrequency: [{ id: "month", label: "month" }],
          defaultOption: { size: "gb", frequency: "month" },
          outputSize: "gb",
          outputFrequency: "month",
          displayInConfigSummary: true,
          defaultValue: 10,
        },
        {
          type: "pricing",
          subType: "singlePricePoint",
          id: "price",
          mappingDefinitionName: "test",
          meteredUnit: { allRegions: "Storage GB" },
        },
        ...(extra.components ?? []),
      ],
    },
    mathsSection: [
      {
        components: [
          {
            type: "maths",
            subType: "basicMaths",
            operation: "multiplication",
            id: "cost",
            decimalPlaces: 2,
            operands: [{ variableId: "storage" }, { variableId: "price" }],
          },
          {
            type: "display",
            subType: "priceDisplay",
            costType: "Monthly",
            label: "Storage cost",
            id: "costDisplay",
            subTotalRefer: "cost",
          },
        ],
      },
    ],
  };
}

async function run(def, overrides = {}, units = { "Storage GB": 0.023 }) {
  const template = selectTemplate(def);
  const engine = new Engine({
    definition: def,
    template,
    region: "us-east-1",
    displayRegion: regionName("us-east-1"),
    maps: mapWith(units),
  });
  await engine.resolveInputs(overrides);
  return { engine, result: engine.evaluate() };
}

test("computes a simple price and includes defaults for rehydration", async () => {
  const { result } = await run(definition({ cards: [storageCard()] }), {
    storage: { text: "100GB" },
  });
  assert.equal(result.monthly, 2.3);
  assert.equal(result.upfront, 0);
  assert.equal(result.summary, "Storage (100 GB per month)");
  assert.deepEqual(result.calculationComponents, {
    storage: { value: "100", unit: "gb|month" },
  });
});

test("uses definition defaults when inputs are omitted", async () => {
  const { result } = await run(definition({ cards: [storageCard()] }));
  assert.equal(result.monthly, 0.23);
  assert.deepEqual(result.calculationComponents.storage, {
    value: "10",
    unit: "gb|month",
  });
});

test("applies progressive tier pricing like the calculator", async () => {
  const card = storageCard();
  card.inputSection.components = [
    card.inputSection.components[0],
    {
      type: "pricing",
      subType: "tieredPricing",
      id: "tiers",
      mappingDefinitionName: "test",
      tiers: {
        allRegions: [
          { startOfTier: 0, endOfTier: 100, meteredUnit: "Tier 1" },
          { startOfTier: 101, endOfTier: -1, meteredUnit: "Tier 2" },
        ],
      },
    },
  ];
  card.mathsSection[0].components = [
    {
      type: "maths",
      subType: "tieredPricingMath",
      id: "cost",
      decimalPlaces: 2,
      inputRefer: "storage",
      tieredPricingRefer: "tiers",
    },
    {
      type: "display",
      subType: "priceDisplay",
      costType: "Monthly",
      label: "Tiered cost",
      id: "costDisplay",
      subTotalRefer: "cost",
    },
  ];
  const { result } = await run(
    definition({ cards: [card] }),
    { storage: { text: "150GB" } },
    { "Tier 1": 1, "Tier 2": 0.5 },
  );
  // 100 units at $1 + 50 units at $0.50
  assert.equal(result.monthly, 125);
});

test("honours dropdown defaults and validates required inputs", async () => {
  const def = definition({
    cards: [
      {
        title: "Main",
        inputSection: {
          components: [
            {
              type: "input",
              subType: "dropdown",
              id: "mode",
              label: "Mode",
              options: [
                { id: "a", label: "Option A" },
                { id: "b", label: "Option B" },
              ],
              defaultDropDownItem: "b",
              displayInConfigSummary: true,
            },
            {
              type: "input",
              subType: "numericInput",
              id: "count",
              label: "Count",
              validations: { required: true },
            },
          ],
        },
        mathsSection: [],
      },
    ],
  });
  await assert.rejects(
    () => run(def),
    (error) => error instanceof AxiError && /Missing required input/.test(error.message),
  );
  const { engine } = await run(def, { count: { text: "3" } });
  assert.equal(engine.values.get("mode"), "b");
  assert.equal(engine.rawInputs.get("mode").value, "b");
});

test("rejects units that the component does not offer", async () => {
  const def = definition({
    cards: [
      {
        title: "Main",
        inputSection: {
          components: [
            {
              type: "input",
              subType: "frequency",
              id: "requests",
              label: "Requests",
              options: [{ id: "perMonth", label: "per month" }],
              defaultFrequency: "perMonth",
              outputFrequency: { id: "perMonth" },
            },
          ],
        },
        mathsSection: [],
      },
    ],
  });
  await assert.rejects(
    () =>
      run(def, {
        requests: { text: "10millionPerMonth" },
      }),
    (error) =>
      error instanceof AxiError && /Invalid unit/.test(error.message),
  );
});

test("computes snapshot maths with the calculator formula", async () => {
  const def = definition({
    cards: [
      {
        title: "Snapshots",
        inputSection: {
          components: [
            {
              type: "input",
              subType: "numericInput",
              id: "size",
              label: "Size",
              defaultValue: 100,
            },
            {
              type: "input",
              subType: "numericInput",
              id: "changed",
              label: "Changed",
              defaultValue: 10,
            },
            {
              type: "input",
              subType: "dropdown",
              id: "freq",
              label: "Frequency",
              options: [{ id: "2", label: "Twice" }],
              defaultDropDownItem: "2",
            },
            {
              type: "pricing",
              subType: "singlePricePoint",
              id: "snapPrice",
              mappingDefinitionName: "test",
              meteredUnit: { allRegions: "Snapshot GB" },
            },
          ],
        },
        mathsSection: [
          {
            components: [
              {
                type: "maths",
                subType: "snapShotMaths",
                id: "snapCost",
                operands: [
                  { operand: "ebsStorage", variableId: "size" },
                  { operand: "amountSnapShotChanged", variableId: "changed" },
                  { operand: "snapShotFrequency", variableId: "freq" },
                  { operand: "snapShotPricing", variableId: "snapPrice" },
                ],
              },
              {
                type: "display",
                subType: "priceDisplay",
                costType: "Monthly",
                label: "Snapshot cost",
                id: "snapDisplay",
                subTotalRefer: "snapCost",
              },
            ],
          },
        ],
      },
    ],
  });
  const { result } = await run(def, {}, { "Snapshot GB": 0.05 });
  // initial 100*0.05 = 5 + (10*0.05/2)*2 = 5.5
  assert.equal(result.monthly, 5.5);
});

test("reports unsupported maths and input types instead of silently returning 0", async () => {
  const def = definition({
    cards: [
      {
        title: "Main",
        inputSection: {
          components: [
            { type: "input", subType: "priceSelector", id: "table", label: "Table" },
          ],
        },
        mathsSection: [],
      },
    ],
  });
  await assert.rejects(
    () => run(def),
    (error) =>
      error instanceof AxiError && error.code === "UNSUPPORTED_SERVICE",
  );
  const surface = supportedSurface(def);
  assert.deepEqual(surface.unsupportedInput, ["priceSelector"]);
});


test("parses data transfer specs into calculator entries", () => {
  const entries = parseDataTransferEntries(
    "OUTBOUND:1TB; INTRA_REGION:100GB; INBOUND:2TB; OUTBOUND:500GB@us-west-2",
    "US East (Ohio)",
  );
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], {
    entryType: "OUTBOUND",
    value: 1,
    unit: "tb_month",
    gb: 1024,
    fromRegion: null,
    toRegion: "External",
    optionType: null,
  });
  assert.equal(entries[1].entryType, "INTRA_REGION");
  assert.equal(entries[1].gb, 100);
  assert.equal(entries[2].fromRegion, "External");
  assert.equal(entries[3].toRegion, "us-west-2");
});

test("prices external outbound data transfer with progressive tiers", () => {
  const engine = new Engine({
    definition: { serviceCode: "test", serviceName: "Test" },
    template: { id: "t", cards: [] },
    region: "us-east-1",
    displayRegion: "US East (N. Virginia)",
    maps: new Map(),
    currency: "USD",
  });
  engine.maps.set(
    "datatransfer-calc",
    mapWith({
      "DataTransfer External Outbound Next 10 TB": 0.09,
      "DataTransfer External Outbound Next 40 TB": 0.085,
    }).get("test"),
  );
  const raw = {
    "DataTransfer External Outbound Next 10 TB": {
      price: "0.09",
      StartingRange: "0",
      EndingRange: "10240",
    },
    "DataTransfer External Outbound Next 40 TB": {
      price: "0.085",
      StartingRange: "10240",
      EndingRange: "51200",
    },
  };
  const map = engine.maps.get("datatransfer-calc");
  map.data = raw;
  map.priceFor = (unit) => (raw[unit] ? Number(raw[unit].price) : null);
  engine.resolveDataTransfer(
    { id: "dataTransferForEC2", mappingDefinitionName: "datatransfer-calc" },
    { value: "OUTBOUND:11TB" },
  );
  assert.ok(Math.abs(engine.values.get("dataTransferForEC2") - 1008.64) < 0.001);
});

test("prices intra-region transfer in both directions", () => {
  const engine = new Engine({
    definition: { serviceCode: "test", serviceName: "Test" },
    template: { id: "t", cards: [] },
    region: "us-east-1",
    displayRegion: "US East (N. Virginia)",
    maps: new Map(),
    currency: "USD",
  });
  engine.maps.set(
    "datatransfer-calc",
    mapWith({ "DataTransfer IntraRegion": 0.01 }).get("test"),
  );
  engine.resolveDataTransfer(
    { id: "dataTransferForEC2", mappingDefinitionName: "datatransfer-calc" },
    { value: "INTRA_REGION:100GB" },
  );
  assert.equal(engine.values.get("dataTransferForEC2"), 2);
});

test("parses dedicated host lists for windows workloads", () => {
  assert.deepEqual(parseDedicatedHosts("c5:2, m5:1"), [
    { family: "c5", instances: 2 },
    { family: "m5", instances: 1 },
  ]);
  assert.deepEqual(parseDedicatedHosts("c5 x2; m5"), [
    { family: "c5", instances: 2 },
    { family: "m5", instances: 1 },
  ]);
  assert.deepEqual(
    parseDedicatedHosts([{ hostFamily: "c5", instances: 3 }]),
    [{ family: "c5", instances: 3 }],
  );
  assert.deepEqual(parseDedicatedHosts({ c5: 2, m5: 1 }), [
    { family: "c5", instances: 2 },
    { family: "m5", instances: 1 },
  ]);
  assert.throws(
    () => parseDedicatedHosts("c5:0"),
    (error) => error instanceof AxiError && /Invalid dedicated host/.test(error.message),
  );
});

test("fails closed on unpublished accelerated transfer options", () => {
  const engine = new Engine({
    definition: { serviceCode: "test", serviceName: "Test" },
    template: { id: "t", cards: [] },
    region: "us-east-1",
    displayRegion: "US East (N. Virginia)",
    maps: new Map(),
    currency: "USD",
  });
  engine.maps.set(
    "datatransfer-calc",
    mapWith({ "DataTransfer External Outbound Next 10 TB": 0.09 }).get("test"),
  );
  assert.throws(
    () =>
      engine.resolveDataTransfer(
        { id: "dataTransferForEC2", mappingDefinitionName: "datatransfer-calc" },
        {
          value: JSON.stringify([
            { entryType: "OUTBOUND", value: 1, unit: "tb_month", optionType: "accelerated" },
          ]),
        },
      ),
    (error) =>
      error instanceof AxiError && error.code === "UNSUPPORTED_SERVICE",
  );
});
