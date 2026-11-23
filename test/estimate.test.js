import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPayload,
  buildServiceEntry,
  parseEstimateKey,
} from "../src/estimate.js";

const definition = {
  serviceCode: "testService",
  serviceName: " Test Service ",
  version: "1.0.0",
};
const template = { id: "main" };
const result = {
  monthly: 12.5,
  upfront: 3,
  summary: "Storage (100 GB per month)",
  calculationComponents: { storage: { value: "100", unit: "gb|month" } },
};

test("builds a calculator-compatible service entry", () => {
  const entry = buildServiceEntry({
    definition,
    template,
    region: "us-east-1",
    result,
  });
  assert.equal(entry.serviceName, "Test Service");
  assert.equal(entry.estimateFor, "main");
  assert.equal(entry.regionName, "US East (N. Virginia)");
  assert.deepEqual(entry.serviceCost, { monthly: 12.5, upfront: 3 });
  assert.deepEqual(entry.calculationComponents, result.calculationComponents);
});

test("builds a payload with correct totals and metadata", () => {
  const entry = buildServiceEntry({ definition, template, region: "us-east-1", result });
  const payload = buildPayload({
    name: "Test estimate",
    services: [entry, { ...entry, serviceCost: { monthly: 0.5, upfront: 0 } }],
  });
  assert.equal(payload.name, "Test estimate");
  assert.equal(payload.totalCost.monthly, 13);
  assert.equal(payload.totalCost.upfront, 3);
  assert.equal(Object.keys(payload.services).length, 2);
  assert.equal(payload.metaData.currency, "USD");
  assert.equal(payload.settings.subTotalModifier.type, "VOLUME_DISCOUNT");
  assert.match(Object.keys(payload.services)[0], /^testService-/);
});

test("parses public estimate URLs and bare ids", () => {
  const id = "53095d74815624a0880feb42bb4fb6e258450942";
  assert.equal(parseEstimateKey(`https://calculator.aws/#/estimate?id=${id}`), id);
  assert.equal(parseEstimateKey(`https://calculator.aws/#/estimate?foo=1&id=${id}`), id);
  assert.equal(parseEstimateKey(id), id);
  assert.equal(parseEstimateKey("nope"), null);
  assert.equal(parseEstimateKey(""), null);
});
