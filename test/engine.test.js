import assert from "node:assert/strict";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

import { Engine, selectTemplate, supportedSurface } from "../src/engine.js";
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
