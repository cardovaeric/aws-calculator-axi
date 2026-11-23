# Calculator coverage

This document tracks what `awscalc` can price from the AWS Pricing Calculator,
what is still missing, and how each piece is validated.

## Current status

| Area | Covered |
|---|---|
| Top-level single services | **162 / 163** |
| Grouped services | **33 / 33** |
| Sub-services inside groups | **205 / 208** |
| Standard AWS regions + Local/Wavelength zones | **116 codes** |
| Per-service region availability | Checked from `regionList/publish.json` |
| PLC 2.0 pricing (instance tables) | On-demand + Reserved (No/Partial/All Upfront) |
| EC2 shared tenancy | On-Demand + Compute/Instance Savings Plans, EBS, monitoring |
| `columnFormIPM` rows | Single row per table, indexed for multi-table services |

Remaining top-level service that cannot be priced yet:

1. **`windowsWorkloads`.** Needs the Windows Server license/workload table,
   dedicated host tables, and `conditionalCheckboxes`/`uploadTable` widgets.

EC2 itself is priceable for **shared tenancy** with On-Demand and Savings Plans
(including EBS and detailed monitoring). EC2 dedicated/host tenancy, Reserved
Instances, Spot, and daily/weekly/monthly spike workloads are rejected with
`UNSUPPORTED_SERVICE` until implemented.

Remaining grouped sub-services:

- `amazonWorkspaces`, `workSpacesThinClient`, `workSpacesSecureBrowser`
  (WorkSpaces Personal / Thin Client / Secure Browser). Their PLC index uses a
  monthly unit shape rather than the hourly shape the column handler expects.

Known accuracy gaps even where a service is priceable:

- **`dataTransferV2`** inputs (S3/EC2/CloudFront data transfer matrices) are
  skipped with a warning. Price transfer as a separate service line if needed.
- **`columnFormIPM` supports one row per table.** Multiple rows of the same
  instance table must be combined by summing separate estimates.
- **Database Savings Plans / other additional pricing data** attached to a
  `columnFormIPM` (`additionalPricingData`) is not implemented. Reserved
  Instances are implemented; Savings Plans are not.
- **Direct Connect ports** use a monthly price hidden behind
  `pricingUnitModel.riPricingTypes.hourly.$overridePriceKeyWith`; this override
  is not wired up yet.
- Some services can return `0` for their default configuration because every
  usage input defaults to 0 (for example DocumentDB, Timestream, Keyspaces).
  That matches the calculator, but always check the config summary.

## Validation method

Every implemented family is validated by:

1. Publishing an estimate with `awscalc price ... --share`.
2. Opening the URL in calculator.aws.
3. Pressing **Update estimate** (which recomputes from the stored
   `calculationComponents`).
4. Confirming stored and recomputed totals match.

Validated so far:

| Service | Configuration | Result |
|---|---|---|
| RDS MySQL | db.m4.10xlarge, Multi-AZ, OnDemand, defaults | `$5,938.92/mo` exact |
| RDS MySQL | db.t3.micro, Single-AZ, Reserved 1yr All Upfront | `$51.65/mo + $98` exact |
| RDS SQL Server | defaults | `$33.06/mo` exact |
| Aurora MySQL | defaults | `$70.61/mo` exact |
| ElastiCache | 2 × cache.t3.micro Redis OnDemand (table 2) | `$24.82/mo` exact |
| OpenSearch | defaults | `$553.34/mo` exact |
| MSK | 3 × express.m7g.large + 100 GB | `$923.52/mo` exact |
| EC2 | default: t4g.nano, Linux, Compute Savings 3yr | `$1.53/mo` exact |
| EC2 | m5.large ×2, Linux, On-Demand | `$140.16/mo` exact |
| EC2 | m5.large, Windows, On-Demand | `$137.24/mo` exact |
| EC2 | m5.large, SQL Server Standard, On-Demand | `$487.64/mo` exact |
| EC2 | m5.large, RHEL, On-Demand | `$91.25/mo` exact |
| EC2 | m5.large, EBS 100 GB gp3, detailed monitoring | `$80.18/mo` exact |
| EC2 | m5.large ×2, Compute Savings 1yr No Upfront | `$103.66/mo` exact |
| Lambda/S3/CloudFront/DynamoDB/Fargate/EBS/API Gateway | see README | exact |

## Remaining roadmap

### Phase 2 — EC2 (partially done)

- [x] `ec2InstanceSearch`: instance lookup with region/OS availability.
- [x] `ec2PriceFetcher`: on-demand + Compute/Instance Savings Plans.
- [x] Constant workload hours and EBS/monitoring cards.
- [ ] Daily/weekly/monthly spike workload math.
- [ ] EC2 Reserved Instances (standard/convertible) and Spot.
- [ ] Dedicated/host tenancy and `dedicatedHostsMath`.

### Phase 3 — Windows workloads

- `conditionalCheckboxes`, Windows Server license table, SQL summary,
  dedicated host review/cost tables, workload price sets.

### Phase 4 — remaining table/selector gaps

- `columnFormIPM` multi-row support.
- `additionalPricingData` (Database Savings Plans).
- Direct Connect `port:PricePerUnit` and monthly port model.
- WorkSpaces monthly unit shape (Personal / Thin Client / Secure Browser).
- `input/priceSelector`, `pricingStrategy`, `radioTiles`,
  `conditionalCheckboxes` widgets.

### Phase 5 — transfer and TCO widgets

- `dataTransferV2` matrix (S3, EC2, CloudFront).
- Remaining `TCOCalculator` layouts.
- Expand the validation harness to run the browser recompute automatically for
  a corpus of estimates.

## Adding a service

1. Run `awscalc service <code> --full` and note unsupported widget types.
2. If the service uses PLC 2.0, check whether `columnFormIPM` already covers it.
3. Add the missing widget/maths handler in `src/engine.js` or `src/plc.js`.
4. Publish an estimate and compare against **Update estimate**.
5. Add an offline unit/e2e test using cached fixtures.
