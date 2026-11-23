# Calculator coverage

This document tracks what `awscalc` can price from the AWS Pricing Calculator,
what is still missing, and how each piece is validated.

## Current status

| Area | Covered |
|---|---|
| Top-level single services | **163 / 163** (Windows workloads: shared tenancy) |
| Grouped services | **33 / 33** |
| Sub-services inside groups | **207 / 208** (WorkSpaces Personal/Core/Instances) |
| Standard AWS regions + Local/Wavelength zones | **116 codes** |
| Per-service region availability | Checked from `regionList/publish.json` |
| PLC 2.0 pricing (instance tables) | On-demand + Reserved (No/Partial/All Upfront) + additional pricing data |
| EC2 tenancy | Shared, Dedicated Instances, Dedicated Hosts |
| EC2 pricing strategies | On-Demand, Compute/Instance Savings Plans, Standard/Convertible RI, Spot, cost-optimized mix |
| EC2 workloads | Constant, daily, weekly, monthly spikes |
| Data transfer | `dataTransferV2` inbound, intra-region, external, inter-region |
| Database Savings Plans | RDS `additionalPricingData` |
| WorkSpaces | Personal, Core Bundles, Core Managed Instances monthly/hourly tables |
| `columnFormIPM` rows | Single row per table, indexed for multi-table services |

Remaining gaps:

1. **Windows workloads dedicated-host workflow.** The shared-tenancy workflow
   (Windows/SQL license included or BYOL, Reserved/Savings/On-Demand, EBS) is
   implemented. The `workflow=dedicated` branch and its upload/recommendation
   tables are not; use EC2 `tenancy=host` for Dedicated Host pricing.
2. **WorkSpaces Pools** usage-pattern optimizer. Personal, Core Bundles, and
   Core Managed Instances are priceable. Thin Client and Secure Browser
   definitions are not published by the calculator (HTTP 403).
3. **Multi-row `columnFormIPM` tables.** One row per table; combine separate
   estimates for multiple rows.
4. `dataTransferV2` accelerated-transfer options are not implemented; standard
   inbound/intra-region/external/inter-region pricing is.

Known accuracy notes:

- Some services can return `0` for their default configuration because every
  usage input defaults to 0 (for example DocumentDB, Timestream, Keyspaces).
  That matches the calculator, but always check the config summary.
- WorkSpaces Core/Personal use the calculator's dependent volume defaults when
  that bundle/OS combination offers them.

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
| Direct Connect | 1 × 100G Dedicated port at Newark | `$16,425/mo` exact |
| EC2 | t4g.nano Spot (54% discount) | `$1.41/mo` exact |
| EC2 | m5.large Standard RI, 1yr No Upfront | `$43.80/mo` exact |
| EC2 | m5.large Dedicated Instance On-Demand | `$1,534.46/mo` exact |
| EC2 | c5 Dedicated Host On-Demand | `$2,457.18/mo` exact |
| EC2 | Monthly spike, cost-optimized 3yr | `$109.01/mo` exact |
| EC2 | m5.large + 1 TB external outbound | `$162.24/mo` exact |
| WorkSpaces Personal | Standard Windows license included | `$33/mo` exact |
| WorkSpaces Personal | AutoStop, 2 workSpaces, 730 h | `$452.50/mo` exact |
| WorkSpaces Core | Standard bundle | `$29/mo` exact |
| WorkSpaces Managed Instances | default | `$2,180.33/mo` exact |
| Windows Workloads | m7i-flex.xlarge, SQL Std BYOL | `$300.08/mo` exact |
| Windows Workloads | SQL Standard license included | `$650.48/mo` exact |
| Windows Workloads | 3yr Convertible All Upfront | `$80/mo + $6,910` exact |
| RDS MySQL | Database Savings Plan db.m7g.large | `$149.77/mo` exact |
| RDS MySQL | Database Savings Plan db.m9g.large | `$158.53/mo` exact |
| OpenSearch | defaults with 3 dedicated masters | `$621.96/mo` exact |
| DocumentDB | 1 × db.r5.large, 730 hours | `$202.21/mo` exact |
| Lambda/S3/CloudFront/DynamoDB/Fargate/EBS/API Gateway | see README | exact |

## Remaining roadmap

### Phase 2 — EC2 (done)

- [x] `ec2InstanceSearch`: instance lookup with region/OS availability.
- [x] `ec2PriceFetcher`: on-demand + Compute/Instance Savings Plans.
- [x] Constant workload hours and EBS/monitoring cards.
- [x] Daily/weekly/monthly spike workload optimizer.
- [x] EC2 Reserved Instances (standard/convertible, all payment options).
- [x] EC2 Spot (spot advisor discount).
- [x] Dedicated Instances (per-region fee) and Dedicated Hosts.
- [x] Data transfer matrix.

### Phase 3 — Windows workloads (shared tenancy done)

- [x] `conditionalCheckboxes`, Windows Server/SQL license selection.
- [x] Shared-tenancy instance pricing, Savings/Reserved/On-Demand.
- [x] EBS volumes and storage math.
- [ ] Dedicated-host review/upload/cost tables (`workflow=dedicated`).

### Phase 4 — remaining table/selector gaps

- [ ] `columnFormIPM` multi-row support.
- [x] `additionalPricingData` (Database Savings Plans, Dedicated Host Savings).
- [x] WorkSpaces monthly unit shape (Personal / Core / Managed Instances).
- [ ] WorkSpaces Pools usage-pattern optimizer.
- [x] `pricingStrategy`, `radioTiles`, `conditionalCheckboxes` widgets used by
  EC2 and Windows workloads.

### Phase 5 — transfer and TCO widgets

- [x] `dataTransferV2` matrix (S3, EC2, CloudFront).
- [ ] Accelerated data transfer options.
- [ ] Remaining `TCOCalculator` layouts.
- [x] Browser recompute harness runs a corpus of estimates.

## Adding a service

1. Run `awscalc service <code> --full` and note unsupported widget types.
2. If the service uses PLC 2.0, check whether `columnFormIPM` already covers it.
3. Add the missing widget/maths handler in `src/engine.js` or `src/plc.js`.
4. Publish an estimate and compare against **Update estimate**.
5. Add an offline unit/e2e test using cached fixtures.
