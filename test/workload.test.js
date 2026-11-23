import assert from "node:assert/strict";
import test from "node:test";

import {
  breakevenHours,
  classifyWorkload,
  commitmentHours,
  consistentInstanceCount,
  effectiveHourlyRate,
  normalizeWorkload,
  totalWorkloadHours,
  workloadFromInputs,
  workloadSummary,
} from "../src/workload.js";

test("classifies a constant workload as fully reserved hours", () => {
  const result = classifyWorkload({ workloadType: "consistent", data: "2" }, 0);
  assert.equal(result.reservedCount, 2);
  assert.equal(result.reservedHours, 1460);
  assert.equal(result.onDemandHours, 0);
  assert.equal(totalWorkloadHours({ workloadType: "consistent", data: "2" }), 1460);
});

test("splits a monthly spike between baseline and peak hours", () => {
  const workload = workloadFromInputs({
    workloadSelection: "monthly",
    baseline: 2,
    peak: 6,
    spikeDays: 5,
    spikeHours: 8,
    spikeMinutes: 0,
  });
  const result = classifyWorkload(workload, 0);
  assert.equal(result.reservedCount, 6);
  assert.equal(result.reservedHours, 2 * 730 + 4 * (5 * 24 + 8));
  assert.equal(result.onDemandHours, 0);
  assert.match(
    workloadSummary(workload),
    /Monthly, Baseline: 2, Peak: 6, Duration of peak: 5 Day 8 Hr 0 Min/,
  );
});

test("keeps peak hours on-demand below the breakeven point", () => {
  const workload = workloadFromInputs({
    workloadSelection: "monthly",
    baseline: 2,
    peak: 6,
    spikeDays: 1,
    spikeHours: 1,
  });
  const result = classifyWorkload(workload, 1000);
  assert.equal(result.reservedCount, 2);
  assert.equal(result.reservedHours, 1460);
  assert.equal(result.ondemandCount, 4);
  assert.equal(result.onDemandHours, 4 * 25);
});

test("uses fixed weekly and daily normalizations", () => {
  const weekly = classifyWorkload(
    {
      workloadType: "weekly",
      data: {
        baseline: { value: 1 },
        peak: { value: 3 },
        days: { value: 2 },
        hours: { value: 4 },
        minutes: { value: 0 },
      },
    },
    0,
  );
  assert.equal(weekly.reservedCount, 3);
  assert.equal(weekly.reservedHours, 730 + 2 * (2 * 24 + 4) * 4.345238095238095);

  const daily = classifyWorkload(
    {
      workloadType: "daily",
      data: [
        {
          baseline: 1,
          peak: 2,
          hours: 4,
          minutes: 0,
          days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        },
      ],
    },
    0,
  );
  assert.equal(daily.reservedCount, 2);
  assert.equal(
    daily.reservedHours,
    5 * 24 * 4.345238095238095 + 5 * 4 * 4.345238095238095,
  );
});

test("computes breakeven and effective hourly rates like the calculator", () => {
  assert.equal(commitmentHours(1), 8760);
  const upfront = 0.5 * 0.06 * commitmentHours(1);
  const effective = effectiveHourlyRate(1, 0.06, upfront);
  assert.ok(Math.abs(effective - 0.03) < 1e-12);
  const breakeven = breakevenHours({
    termYears: 1,
    upfrontCost: 0,
    monthlyCost: 0.06 * 730,
    onDemandRate: 0.096,
  });
  assert.ok(Math.abs(breakeven - 456.25) < 0.01);
});

test("normalizes selected days and rejects unknown ones", () => {
  const workload = normalizeWorkload({
    workloadType: "daily",
    selectedDays: "Mon,Wed",
    data: { baseline: 1, peak: 2, hours: 1, minutes: 0 },
  });
  assert.deepEqual(workload.data[0].days, ["Monday", "Wednesday"]);
  assert.equal(consistentInstanceCount({ workloadType: "consistent", data: "3" }), 3);
  assert.throws(
    () =>
      normalizeWorkload({
        workloadType: "daily",
        selectedDays: "Funday",
        data: { baseline: 1, peak: 2 },
      }),
    /Unknown day/,
  );
});
