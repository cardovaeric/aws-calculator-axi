# awscalc

An [AXI](https://toonformat.dev/)-style CLI for the **AWS Pricing Calculator**. It computes prices from the calculator's own live service definitions and pricing maps, then publishes a **public `calculator.aws` estimate URL** that anyone can open.

```console
$ awscalc price --service lambda --region us-east-1 \
    --set numberOfRequests=10millionPerMonth \
    --set durationOfEachRequest=200 \
    --set sizeOfMemoryAllocated=512MB \
    --share
service: AWS Lambda
monthly: 11.83
upfront: 0
total12Months: 141.96
currency: USD
url: "https://calculator.aws/#/estimate?id=..."
```

## Why this is accurate

`awscalc` does not approximate AWS prices with its own rate card. It reads the same data the calculator UI reads:

1. **Service definitions** from `d1qsjq9pzbk1k6.cloudfront.net/data/<service>/en_US.json` — inputs, defaults, visibility rules, and the `mathsSection` cost formulas.
2. **Metered-unit price maps** from `calculator.aws/pricing/2.0/meteredUnitMaps/...` — the current per-region prices the calculator applies.
3. It evaluates the same intermediate rounding, tier boundaries, free tiers, unit conversions, and duration/frequency rules that the calculator uses.
4. It saves the estimate to the same `saveAs` endpoint the UI uses, so the returned URL is a real public calculator estimate.

The generated estimate includes every visible input, so **Update estimate** in calculator.aws rehydrates the configuration and recomputes the same total.

## Install

```sh
npm install -g github:cardovaeric/aws-calculator-axi
# or from a checkout
npm install && npm link
```

Requires Node.js 20+.

## Commands

Run with no arguments to see recent estimates for the current directory and suggested next steps.

```console
awscalc                                        # live home view
awscalc services [--filter s3] [--all]         # browse the catalog
awscalc service <code> [--full]                # inputs, defaults, units
awscalc regions --service <code>               # valid regions
awscalc price --service <code> [flags]         # compute (and publish)
awscalc get <url|id>                           # read a published estimate
```

### `price` flags

| Flag | Meaning |
| --- | --- |
| `--service <code>` | Service code or alias (`lambda`, `s3`, `cloudfront`, ...) |
| `--template <id>` | Template when a service has more than one mode |
| `--region <code>` | AWS region code (default `us-east-1`) |
| `--set <id=value>` | Set an input; repeatable, values may include units |
| `--input-json <path>` | JSON object of inputs (`-` for stdin) |
| `--subservice <code>` | Select a grouped sub-service (S3, DynamoDB, EMR, ...) |
| `--share` | Publish the estimate to calculator.aws and print the URL |
| `--name <text>` | Estimate name used when publishing |
| `--description <text>` | Description stored on the service line |
| `--explain` | Per-line cost breakdown and calculation trace |
| `--json` | Raw JSON instead of TOON |
| `--refresh` / `--offline` | Bypass or require the local cache |

## Values and units

Inputs use the calculator's own ids. `awscalc service <code>` lists them.

```sh
# file sizes accept size + optional per-time unit
--set storageAmount=500GB
--set dataTransferedToInternet_US=1TB/month
--set sizeOfMemoryAllocated=512MB

# frequency inputs accept the unit labels the calculator offers
--set numberOfRequests=10millionPerMonth
--set standardQueueRequests=2millionPerMonth
--set averageNumberOfNewConnectionsPerALB=100perSecond

# durations accept their dropdown units
--set taskDuration=5min
--set durationOfInstanceRuns=730hours

# dropdowns accept an id or label
--set storageType="Storage General Purpose gp3 GB Mo"
--set selectArchitecture=x86

# percentages are entered as percentages
--set standardWritesId=100
```

If a unit is not offered by that input, the CLI fails instead of silently mispricing. The full error lists the valid units.

## Grouped services

Some calculator entries are groups of sub-services. `s3`, `dynamodb`, `emr`, `sns`, `glue`, `backup`, `step-functions`, `sagemaker`, and others use this model.

```sh
# default sub-services chosen by the calculator
awscalc price --service s3 --set s3StandardStorageSize=100GB

# choose exactly which sub-services are in the estimate
awscalc price --service s3 \
  --subservice amazonS3Standard \
  --subservice amazonS3StandardInfrequentAccess \
  --set s3StandardStorageSize=100GB \
  --set s3IaStorageSize=50GB
```

The published URL stores the sub-services together, exactly like the UI.

## Accuracy examples

Validated by publishing an estimate and comparing the stored total with the calculator's own **Update estimate** recomputation:

| Service | Configuration | Result |
| --- | --- | --- |
| Lambda | 10M requests, 200 ms, 512 MB, 1 GB ephemeral | `$11.83/mo` |
| S3 Standard | 100 GB + 1M PUT + 10M GET | `$11.30/mo` |
| CloudFront | 1 TB US transfer + 10M HTTPS requests | `$97.04/mo` |
| DynamoDB on-demand | 100 GB, 10M writes, 50M reads | `$34.38/mo` |
| DynamoDB provisioned | 100 GB, reserved capacity defaults | `$51.14/mo` + `$180` upfront |
| Fargate | 10 tasks/day, 5 min, 1 vCPU, 2 GB | `$1.35/mo` |
| API Gateway | 10M REST requests | `$49.60/mo` |
| EBS | 100 GB gp3 + default snapshots | `$19.49/mo` |
| EC2 | t4g.nano Linux Compute Savings 3yr | `$1.53/mo` |
| EC2 | m5.large ×2 Linux On-Demand | `$140.16/mo` |
| EC2 | m5.large Windows On-Demand | `$137.24/mo` |
| EC2 | m5.large Standard RI 1yr No Upfront | `$43.80/mo` |
| EC2 | Dedicated Instance m5.large On-Demand | `$1,534.46/mo` (incl. `$1,460` region fee) |
| EC2 | Dedicated Host c5 On-Demand | `$2,457.18/mo` |
| EC2 | Monthly spike, cost-optimized 3yr | `$109.01/mo` |
| EC2 | m5.large + 1 TB external outbound | `$162.24/mo` |
| WorkSpaces Personal | Standard, Windows, license included | `$33/mo` |
| Windows Workloads | m7i-flex.xlarge, SQL BYOL | `$300.08/mo` |
| RDS MySQL | Database Savings Plan, db.m7g.large | `$149.77/mo` |

## Coverage

The calculator publishes 441 service definitions. `awscalc` can price:

- **163 of 163 top-level single services** (Windows workloads: shared tenancy)
- **33 of 33 grouped services**, with **207 of 208 sub-services**
- PLC 2.0 instance tables (RDS family, Aurora, ElastiCache, OpenSearch, MSK, Neptune, DocumentDB, Redshift, Keyspaces, MemoryDB, …) including **Reserved Instances** (No/Partial/All Upfront)
- **EC2** shared/dedicated/host tenancy; On-Demand, Compute/Instance Savings Plans, Standard/Convertible Reserved Instances, Spot, and cost-optimized mixed strategies; constant and daily/weekly/monthly spike workloads; EBS, monitoring, and data transfer
- **Dedicated Host** pricing through EC2 `tenancy=host` (host family on-demand, Reserved, and Savings Plans)
- **Windows Server and SQL Server on EC2** shared-tenancy workflows
- **WorkSpaces Personal, Core Bundles, and Core Managed Instances** monthly/hourly bundle tables
- **Database Savings Plans** for RDS via the calculator's `additionalPricingData` artifact
- **`dataTransferV2`** inbound, intra-region, external outbound, and inter-region matrices

Still missing:

- Windows Server/SQL Server **dedicated-host workflow** inside the `windowsWorkloads` service (use EC2 host tenancy instead)
- WorkSpaces **Pools** usage-pattern optimizer and WorkSpaces Thin Client/Secure Browser (the calculator does not publish those definitions)
- Multi-row `columnFormIPM` tables (one row per table)

See [docs/COVERAGE.md](docs/COVERAGE.md) for the full status and roadmap.

Run `awscalc services` for the catalog and `awscalc service <code>` for a service's supported inputs. Grouped services list their sub-services and which ones are in the calculator default.

## EC2

EC2 uses its own instance catalog and savings-plan artifacts:

```sh
# Defaults match the calculator UI: cheapest current-generation instance,
# Linux, Compute Savings Plans 3yr No Upfront
awscalc price --service ec2 --region us-east-2 --share

# On-Demand with a chosen instance and count
awscalc price --service ec2 --region us-east-2 \
  --set pricingStrategy=on-demand \
  --set instanceType=m5.large \
  --set instances=2 --share

# Windows, SQL Server, RHEL, Ubuntu Pro, ...
awscalc price --service ec2 --region us-east-2 \
  --set selectedOS=windows-std \
  --set instanceType=m5.large \
  --set pricingStrategy=on-demand

# EBS and detailed monitoring
awscalc price --service ec2 --region us-east-2 \
  --set instanceType=m5.large \
  --set storageType="Storage General Purpose gp3 GB Mo" \
  --set storageAmount=100GB \
  --set detailedMonitoringCheckbox=true
```

Selectors: `tenancy` (`shared`/`dedicated`/`host`), `instanceType`, `instances`, `pricingStrategy` (`on-demand`, `compute-savings`, `instance-savings`, `cost-optimized`, `standard`, `convertible`, `spot`), `term` (`1yr`/`3yr`), `upfront` (`None`, `Partial Upfront`, `All Upfront`), `workloadSelection` (`consistent`/`daily`/`weekly`/`monthly`), and `dataTransferForEC2`.

```sh
# Reserved Instances (1 year, All Upfront)
awscalc price --service ec2 --region us-east-2 \
  --set pricingStrategy=standard --set term=1yr --set upfront="All Upfront" \
  --set instanceType=m5.large

# Dedicated Instance (adds the calculator's per-region fee)
awscalc price --service ec2 --region us-east-2 \
  --set tenancy=dedicated --set instanceType=m5.large --set pricingStrategy=on-demand

# Dedicated Host family (on-demand, Reserved, or Savings Plans)
awscalc price --service ec2 --region us-east-2 \
  --set tenancy=host --set instanceType=c5 --set pricingStrategy=standard \
  --set term=3yr --set upfront=None

# Monthly spike workload, cost-optimized mix of Reserved + On-Demand
awscalc price --service ec2 --region us-east-2 \
  --set pricingStrategy=cost-optimized --set instanceType=m5.large \
  --set workloadSelection=monthly --set baseline=2 --set peak=6 \
  --set spikeDays=5 --set spikeHours=8

# Daily spike across weekdays (Mon..Fri)
awscalc price --service ec2 --region us-east-2 \
  --set workloadSelection=daily --set workloadDays=Mon,Tue,Wed,Thu,Fri \
  --set baseline=1 --set peak=3 --set spikeHours=4

# Data transfer matrix: OUTBOUND, INTRA_REGION, INBOUND; add @region for inter-region
awscalc price --service ec2 --region us-east-2 --set instanceType=m5.large \
  --set dataTransferForEC2="OUTBOUND:1TB; INTRA_REGION:100GB; OUTBOUND:500GB@us-west-2"
```

Spike workloads use the calculator's breakeven optimizer: baseline instances are committed and peak hours are split between the commitment and On-Demand at the calculator's breakeven point. The `--set` form above is a convenience; a full calculator workload object can also be passed as JSON to `workload` or through `--input-json`.

When EC2 publishes the estimate, the exact workload object and data transfer entries are stored, so **Update estimate** recomputes the same optimizer.

## PLC 2.0 services (RDS, Aurora, ElastiCache, MSK, …)

These services use calculator instance tables instead of flat metered-unit prices. `awscalc` exposes the table row as selector inputs:

```sh
# RDS MySQL, on-demand
awscalc price --service rds-mysql --region us-east-1 \
  --set instanceType=db.t3.micro \
  --set deployment=Single-AZ \
  --set nodes=1 \
  --set storageAmount=100GB \
  --share

# Reserved Instance: 1 year, All Upfront
awscalc price --service rds-mysql --region us-east-1 \
  --set instanceType=db.t3.micro \
  --set deployment=Single-AZ \
  --set pricingModel=Reserved \
  --set term=1yr \
  --set purchaseOption=All

# ElastiCache cluster table (second instance table, hence the 2 suffix)
awscalc price --service elasticache --region us-east-1 \
  --set nodes2=2 \
  --set instanceType2=cache.t3.micro \
  --set engine2=Redis \
  --set pricingModel2=OnDemand \
  --share

# MSK brokers
awscalc price --service msk --region us-east-1 \
  --set nodes=3 \
  --set computeFamily=express.m7g.large
```

Aliases: `instanceType`, `computeFamily`, `nodes`, `deployment`, `pricingModel`, `term`, `purchaseOption`, `utilization`, `engine`, `instanceFamily`. For services with multiple instance tables, append the table index (`instanceType2`, `deployment2`, …). `awscalc service <code>` lists the exact aliases and available selector values for the selected region.

## WorkSpaces, Windows workloads, and Database Savings Plans

```sh
# WorkSpaces Personal (monthly AlwaysOn default)
awscalc price --service amazonWorkspaces --region us-east-1 --set workspaces=2

# Hourly / AutoStop billing (base monthly + hourly usage)
awscalc price --service amazonWorkspaces --region us-east-1 \
  --set license=Included --set runningMode=AutoStop --set workspaces=2 \
  --set utilization=100

# WorkSpaces Core bundle and Core Managed Instances
awscalc price --service workSpacesCore --region us-east-1
awscalc price --service workSpacesInstances --region us-east-1

# Windows Server + SQL Server on EC2 (shared tenancy)
awscalc price --service windowsWorkloads --region us-east-2 \
  --set instanceType=m7i-flex.xlarge \
  --set operatingSystem=windows-li --set sqlServerVersion=std-byol \
  --set quantity=1 --set storageType="General Purpose (gp3)" --set storageAmount=1000GB

# Database Savings Plans for RDS MySQL
awscalc price --service rds-mysql --region us-east-1 \
  --set pricingModel="Database Savings Plans" --set term=1yr \
  --set deployment=Single-AZ --set instanceType=db.m7g.large
```

Windows workloads support the shared-tenancy workflow (Windows license-included/BYOL and SQL Server Standard/Web/Enterprise BYOL or license-included), Reserved Instances, Savings Plans, On-Demand, and one machine specification with EBS volumes. The dedicated-host workflow inside `windowsWorkloads` is not implemented; price Dedicated Hosts with `--service ec2 --set tenancy=host`.

## Regions

Region handling is data-driven:

- 116 region codes are known, including standard regions, Local Zones, Wavelength Zones, GovCloud, ISO, and sovereign regions.
- Each service's offered regions come from the calculator's own `regionList/publish.json`, so services are rejected in regions where the calculator does not offer them (for example CloudFront in `eu-north-1`).
- Local/Wavelength zones use their own price entry when one exists, otherwise they fall back to the parent region's prices.
- `awscalc regions --service <code>` shows the exact list for that service.

A service or sub-service can be perfectly valid in one region and unavailable in another; the CLI checks this before computing or publishing.

## Caching

- Catalog: 6 hours
- Service definitions: 24 hours
- Pricing maps: 6 hours
- Location: `~/.cache/awscalc` (override with `AWSCALC_CACHE_DIR`)
- History: `~/.local/state/awscalc/history.json` (override with `AWSCALC_HISTORY_PATH`)

Use `--refresh` to bypass the cache or `--offline` to require it.

## AXI behavior

- TOON on stdout; diagnostics on stderr
- `--version`/`-v`/`-V` answered before the command graph loads
- Structured errors on stdout with actionable `help`
- Exit codes: `0` success, `1` runtime/upstream error, `2` usage error
- Unknown flags are rejected by name with the valid flag list
- No interactive prompts; everything is flags
- Definite empty states (for example, no recent estimates in this directory)

## Development

```sh
npm test                     # unit + offline end-to-end + fast-path latency tests
npm run verify:calculator    # publish + browser recompute parity checks
npm link                     # expose `awscalc`
```

`npm run verify:calculator` needs `agent-browser` and a browser. It publishes a
corpus of estimates, opens each URL, clicks **Update estimate**, and fails if the
recomputed total differs. The backend endpoint map and state shapes are in
[docs/API-MAP.md](docs/API-MAP.md).

The validation workflow used while developing lives outside the test suite because it needs a browser and the live calculator: publish with `--share`, open the URL, click **Update estimate**, and compare the recomputed total.

Not affiliated with Amazon Web Services. Estimates are estimates; verify before committing spend.
