import assert from "node:assert/strict";
import test from "node:test";

import {
  cheapestEc2Instance,
  ec2OsSelection,
  extractEc2SavingsRate,
  findEc2Instance,
  findEc2Price,
  selectEc2Aggregation,
} from "../src/ec2.js";

const context = {
  display: "US East (Ohio)",
  aggregation: {
    aggregations: [
      {
        selectors: {
          TermType: "OnDemand",
          Tenancy: "Shared",
          "Operating System": "Linux",
          "Pre Installed S/W": "NA",
          "License Model": "No License required",
          LeaseContractLength: "",
          PurchaseOption: "",
          OfferingClass: "",
          "Current Generation": "Yes",
        },
      },
      {
        selectors: {
          TermType: "OnDemand",
          Tenancy: "Shared",
          "Operating System": "Windows",
          "Pre Installed S/W": "NA",
          "License Model": "No License required",
          LeaseContractLength: "",
          PurchaseOption: "",
          OfferingClass: "",
          "Current Generation": "Yes",
        },
      },
      {
        selectors: {
          TermType: "OnDemand",
          Tenancy: "Shared",
          "Operating System": "Windows",
          "Pre Installed S/W": "NA",
          "License Model": "License Included - Infrastructure",
          LeaseContractLength: "",
          PurchaseOption: "",
          OfferingClass: "",
          "Current Generation": "Yes",
        },
      },
    ],
  },
};

test("maps EC2 OS ids to calculator selector values", () => {
  assert.deepEqual(ec2OsSelection("windows-std"), {
    os: "Windows",
    preInstalled: "SQL Std",
  });
  assert.deepEqual(ec2OsSelection("rhel-ha"), {
    os: "Red Hat Enterprise Linux with HA",
    preInstalled: "NA",
  });
});

test("selects the OS-bundled license rate", () => {
  const hit = selectEc2Aggregation(context, {
    tenancy: "Shared",
    os: "Windows",
    preInstalled: "NA",
    termType: "OnDemand",
  });
  assert.equal(
    hit.aggregation.selectors["License Model"],
    "No License required",
  );
});

const index = {
  regions: {
    "US East (Ohio)": {
      a: { "Instance Type": "m5.large", price: "0.096" },
      b: { "Instance Type": "t4g.nano", price: "0.0042" },
      c: { "Instance Type": "m5.xlarge", price: "0.192" },
    },
  },
};

test("finds an instance and the cheapest instance", () => {
  assert.equal(
    findEc2Instance(index, "US East (Ohio)", "m5.large").price,
    "0.096",
  );
  assert.equal(
    cheapestEc2Instance(index, "US East (Ohio)")["Instance Type"],
    "t4g.nano",
  );
  assert.throws(
    () => findEc2Instance(index, "US East (Ohio)", "m5.24xlarge"),
    /not available/,
  );
});

test("extracts a savings plan rate using the calculator key format", () => {
  const savings = {
    regions: {
      "US East (Ohio)": {
        "ComputeSavingsPlans m5.large 3 year No Upfront": { price: "0.0706" },
      },
    },
  };
  assert.equal(
    extractEc2SavingsRate(savings, "US East (Ohio)", {
      kind: "compute-savings",
      term: 3,
      purchaseOption: "No Upfront",
      instanceType: "m5.large",
    }),
    0.0706,
  );
  assert.equal(
    extractEc2SavingsRate(savings, "US East (Ohio)", {
      kind: "instance-savings",
      term: 3,
      purchaseOption: "No Upfront",
      instanceType: "m5.large",
    }),
    null,
  );
});


test("reads hourly, monthly, and upfront dimensions for one instance", () => {
  const priceIndex = {
    regions: {
      "US East (Ohio)": {
        hourly: { "Instance Type": "m5.large", price: "0.06", Unit: "Hrs" },
        upfront: { "Instance Type": "m5.large", price: "494", Unit: "Quantity" },
      },
    },
  };
  const price = findEc2Price(priceIndex, "US East (Ohio)", "m5.large");
  assert.equal(price.hourly, 0.06);
  assert.equal(price.upfront, 494);
  assert.equal(price.monthly, 0);
  assert.equal(price.entries.length, 2);
});
