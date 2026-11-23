import assert from "node:assert/strict";
import test from "node:test";

import { extractPrices, selectAggregation } from "../src/plc.js";

const context = {
  display: "US East (N. Virginia)",
  aggregation: {
    aggregations: [
      {
        selectors: {
          "Deployment Option": "Single-AZ",
          "Instance Type": "db.t3.micro",
          vCPU: "2",
          TermType: "OnDemand",
        },
      },
      {
        selectors: {
          "Deployment Option": "Multi-AZ",
          "Instance Type": "db.t3.micro",
          vCPU: "2",
          TermType: "OnDemand",
        },
      },
      {
        selectors: {
          "Deployment Option": "Single-AZ",
          "Instance Type": "db.t3.micro",
          vCPU: "2",
          TermType: "Reserved",
        },
      },
    ],
  },
};

test("selects the matching aggregation entry", () => {
  const hit = selectAggregation(context, {
    "Instance Type": "db.t3.micro",
    "Deployment Option": "Multi-AZ",
    TermType: "OnDemand",
  });
  assert.equal(hit.selectors["Deployment Option"], "Multi-AZ");
});

test("reports close instance types when no aggregation matches", () => {
  assert.throws(
    () =>
      selectAggregation(context, {
        "Instance Type": "db.t4g.micro",
      }),
    (error) => /No calculator price matches/.test(error.message),
  );
});

test("extracts on-demand hourly prices", () => {
  const prices = extractPrices(
    {
      regions: {
        "US East (N. Virginia)": {
          "db.t3.micro OnDemand Hrs": {
            Unit: "Hrs",
            TermType: "OnDemand",
            price: "0.017",
          },
        },
      },
    },
    "US East (N. Virginia)",
    { termType: "OnDemand" },
  );
  assert.equal(prices.hourly, 0.017);
  assert.equal(prices.upfront, 0);
});

test("extracts reserved hourly and upfront dimensions", () => {
  const prices = extractPrices(
    {
      regions: {
        "US East (N. Virginia)": {
          "db.t3.micro Reserved 1yr Partial Upfront Hrs": {
            Unit: "Hrs",
            TermType: "Reserved",
            LeaseContractLength: "1yr",
            PurchaseOption: "Partial Upfront",
            price: "0.0114",
          },
          "db.t3.micro Reserved 1yr Partial Upfront Quantity": {
            Unit: "Quantity",
            TermType: "Reserved",
            LeaseContractLength: "1yr",
            PurchaseOption: "Partial Upfront",
            price: "100",
          },
          "db.t3.micro Reserved 3yr All Upfront Quantity": {
            Unit: "Quantity",
            TermType: "Reserved",
            LeaseContractLength: "3yr",
            PurchaseOption: "All Upfront",
            price: "420",
          },
        },
      },
    },
    "US East (N. Virginia)",
    {
      termType: "Reserved",
      term: "1 year",
      purchaseOption: "partial",
    },
  );
  assert.equal(prices.hourly, 0.0114);
  assert.equal(prices.upfront, 100);
});

test("exposes non-hourly unit prices separately", () => {
  const prices = extractPrices(
    {
      regions: {
        "US East (N. Virginia)": {
          "port hourly": {
            Unit: "GB",
            price: "0.02",
            "port:PricePerUnit": "22.5",
          },
        },
      },
    },
    "US East (N. Virginia)",
    { termType: "OnDemand" },
  );
  assert.equal(prices.perUnit, 0.02);
});
