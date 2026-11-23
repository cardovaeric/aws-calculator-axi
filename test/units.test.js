import assert from "node:assert/strict";
import test from "node:test";

import {
  ceilTo,
  convertDuration,
  convertFrequency,
  convertSize,
  formatNumber,
  roundHalfUp,
} from "../src/units.js";
import { regionName, resolveRegion } from "../src/regions.js";

test("converts binary file sizes", () => {
  assert.equal(convertSize(1, "tb", "gb"), 1024);
  assert.equal(convertSize(512, "mb", "gb"), 0.5);
  assert.equal(convertSize(1, "gb", "mb"), 1024);
});

test("converts frequency units with the calculator's 730-hour month", () => {
  assert.equal(convertFrequency(10, "perDay", "perMonth"), (10 * 730) / 24);
  assert.equal(convertFrequency(2, "millionPerMonth", "perMonth"), 2_000_000);
  assert.equal(convertFrequency(1, "perSecond", "perMonth"), 2_628_000);
});

test("converts durations and can round up like the duration widget", () => {
  assert.equal(convertDuration(5, "min", "hr"), 5 / 60);
  assert.equal(ceilTo(convertDuration(5, "min", "hr"), 2), 0.09);
  assert.equal(convertDuration(30, "day", "day"), 30);
});

test("roundHalfUp mirrors Number(...).toFixed(decimalPlaces)", () => {
  assert.equal(roundHalfUp(1.825, 2), Number((1.825).toFixed(2)));
  assert.equal(roundHalfUp(1.825, 2), 1.82);
  assert.equal(roundHalfUp(23.375, 2), 23.38);
  assert.equal(roundHalfUp(0.936, 2), 0.94);
});

test("formats numbers without trailing zeros", () => {
  assert.equal(formatNumber(100), "100");
  assert.equal(formatNumber(0.5), "0.5");
  assert.equal(formatNumber(0.125), "0.125");
});

test("resolves AWS region codes and display names", () => {
  assert.equal(resolveRegion("us-east-2"), "us-east-2");
  assert.equal(resolveRegion("US East (Ohio)"), "us-east-2");
  assert.equal(resolveRegion("nope"), null);
  assert.equal(regionName("eu-west-1"), "EU (Ireland)");
});
