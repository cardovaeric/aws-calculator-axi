# Calculator backend API map

Everything below was captured from the live calculator with `agent-browser` HAR
recordings. All paths are relative to `https://calculator.aws/pricing/2.0/meteredUnitMaps/`.

## EC2

Base region path:

```text
ec2/USD/current/ec2-calc/<URL-encoded region display name>/
```

### Instance catalog

```text
.../primary-selector-aggregations.json
```

Aggregations are grouped by:

```text
TermType, Tenancy, Operating System, Pre Installed S/W, License Model,
LeaseContractLength, PurchaseOption, OfferingClass, Current Generation
```

Instance types are **not** in the aggregation selectors. They are entries inside
the price index.

### On-Demand / Reserved price index

```text
.../OnDemand/<Tenancy>/<OS>/<PreInstalledSW>/<LicenseModel>/<CurrentGeneration>/index.json
.../Reserved/<Tenancy>/<OS>/<PreInstalledSW>/<LicenseModel>/<Term>/<Purchase>/<OfferingClass>/<CurrentGeneration>/index.json
```

Examples:

```text
.../OnDemand/Shared/Linux/NA/No%20License%20required/Yes/index.json
.../Reserved/Shared/Linux/NA/No%20License%20required/1yr/All%20Upfront/convertible/Yes/index.json
```

Each region entry contains one object per instance type with `price`, `Unit`,
`Instance Type`, `vCPU`, `Memory`, `Operating System`, `License Model`, etc.

**Important:** the calculator selects `License Model: "No License required"` for
Linux, Windows, RHEL, SUSE, and SQL Server. That rate already bundles the OS/SQL
license. `License Included - Infrastructure` is a lower, BYOL-style rate and is
not what the UI uses by default.

### Savings Plans

```text
computesavingsplan/USD/current/compute-ec2-calc/<region>/<Tenancy>/<OS>/<PreInstalledSW>/<Term>/<Purchase>/index.json
computesavingsplan/USD/current/instance-ec2-calc/<region>/<Tenancy>/<OS>/<PreInstalledSW>/<Term>/<Purchase>/index.json
```

Keys look like:

```text
ComputeSavingsPlans m5.large 3 year No Upfront
EC2InstanceSavingsPlans m5.large 3 year No Upfront
```

The value `price` is the effective hourly rate used by the calculator.

### Spot

```text
https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json
```

```text
spot_advisor[regionCode][OperatingSystem][instanceType].s
```

`OperatingSystem` is `Linux` / `Windows` (capitalized). Cost:

```text
onDemandRate * hours * (1 - discount/100)
```

### Dedicated Hosts

```text
ec2/USD/current/dedicatedhost-calc/metadata.json
ec2/USD/current/dedicatedhost-calc/<region>/primary-selector-aggregations.json
ec2/USD/current/dedicatedhost-calc/<region>/Reserved/<instance>/<vCPU>/<physicalCores>/index.json
```

Not yet implemented.

## EC2 calculation components

Saved state that must be reproduced for `Update estimate`:

```json
"workloadSelection": { "value": "consistent" },
"workload": { "value": { "workloadType": "consistent", "data": "1" } },
"instanceType": { "value": "t4g.nano" },
"pricingStrategy": { "value": {
  "selectedOption": "compute-savings",
  "term": "3 Year",
  "upfrontPayment": "None",
  "model": "computeSavings"
}}
```

Spot:

```json
"pricingStrategy": { "value": {
  "selectedOption": "spot",
  "spotDiscountPercentage": "54"
}}
```

The EC2 price display reads paths from `ec2AdvPricingStrategyMath`:

```text
onDemandCost, upfrontCost, monthlyCost, instanceSavingsCost, computeSavingsCost
```

Only the selected strategy’s path is non-zero.

### Workload findings

Consistent workload: `totalHours = instances * 730`.

Daily pattern findings from the calculator’s own breakdown:

```text
baseline instances  -> baseline * 730 hours
peak extra          -> (peak - baseline) * (hours + minutes/60)
                       * selectedDays.length * 4.345238095238095
```

The calculator then runs a **cost-optimizer** that covers part of the hours with
Savings Plans and the rest with On-Demand using a breakeven calculation, so a
naive `hours * savingsRate` is wrong. Spike workloads are therefore still
fail-closed.

## RDS / Aurora / DocumentDB / ElastiCache / OpenSearch / MSK / Redshift

PLC 2.0 mapping:

```text
<serviceId>/<currency>/current/<source>/metadata.json
<serviceId>/<currency>/current/<source>/<region>/primary-selector-aggregations.json
<serviceId>/<currency>/current/<source>/<Location>/<selectors...>/index.json
```

`metadata.json` defines `primarySelectors` / `secondarySelectors`; the index path
is the selector values in that order. `sets` groups related price dimensions.

### columnFormIPM state

```json
"columnFormIPM": { "value": [ {
  "Number of Nodes": { "value": "3" },
  "Instance Type": { "value": "db.t3.micro" },
  "undefined": { "value": { "unit": "730", "selectedId": "Hours/Month" } },
  "Deployment Option": { "value": "Single-AZ" },
  "TermType": { "value": "OnDemand" }
} ] }
```

Findings:

- `nodeRow` is not always `exportValueAs: "count"`. OpenSearch uses
  `count_1` / `count_2`; the table defaults are 1 and **3**.
- Utilization defaults can be an object: `{ unit: "730", selectedId: "Hours/Month" }`
  (DocumentDB). Treat that as 730 hours, not 0%.
- The RDS UI is single-row; extra rows in `columnFormIPM` are ignored by the
  calculator, so the CLI rejects them.

## Validation

`scripts/verify-calculator.mjs` publishes each case, opens the URL, presses
**Update estimate**, and compares the stored and recomputed totals.

```sh
npm run verify:calculator
```
