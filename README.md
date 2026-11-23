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

## Supported services

Anything whose definition uses the supported calculator widgets:

- maths: `basicMaths`, `tieredPricingMath`, `rounding`, `maxMin`, `variable`, `snapShotMaths`
- pricing: `singlePricePoint`, `tieredPricing`, `pricingComboV2`, `replace`, `concatenate`
- inputs: numeric, dropdown, frequency, file size, duration, percent, throughput, utilization, checkbox

That covers most of the catalog, including Lambda, S3, CloudFront, DynamoDB, EBS, EFS, ECR, API Gateway, SQS, SNS, Kinesis, CloudWatch, Route 53, EventBridge, KMS, Secrets Manager, ELB, NAT Gateway, VPC endpoints, Fargate, EKS, CodeBuild, and more.

**Explicitly unsupported for now** (the CLI fails with a clear message rather than returning `0`):

- EC2 instance pricing and workload/instance-finder widgets
- PLC 2.0 pricing services such as RDS, Aurora, ElastiCache, MSK, Redshift, OpenSearch, Neptune, DocumentDB, Keyspaces
- Data-transfer matrix widgets (`dataTransferV2`) — these are skipped with a warning; price transfer separately if needed

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
npm test          # unit + offline end-to-end + fast-path latency tests
npm link          # expose `awscalc`
```

The validation workflow used while developing lives outside the test suite because it needs a browser and the live calculator: publish with `--share`, open the URL, click **Update estimate**, and compare the recomputed total.

Not affiliated with Amazon Web Services. Estimates are estimates; verify before committing spend.
