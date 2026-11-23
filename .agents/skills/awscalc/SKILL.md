---
name: awscalc
description: Estimate AWS costs and publish public AWS Pricing Calculator URLs. Use when asked what an AWS architecture will cost, to price EC2 alternatives on other services (Lambda, S3, DynamoDB, CloudFront, Fargate, RDS alternatives, EBS, ELB, NAT, and more), to compare AWS regions, or to create a shareable calculator.aws estimate link.
---

# awscalc

Compute AWS costs from the AWS Pricing Calculator's own live service definitions and pricing maps, then publish a public `calculator.aws` estimate URL.

Run commands without a global install:

```sh
npx -y --package github:cardovaeric/aws-calculator-axi -- awscalc services
```

If `awscalc` is already on PATH, drop the `npx ... --` prefix.

## Workflow

1. Find the service code (or use a friendly alias):

```sh
awscalc services --filter lambda
awscalc service lambda
```

2. Price a configuration. Input ids come from the service schema:

```sh
awscalc price --service lambda --region us-east-1 \
  --set numberOfRequests=10millionPerMonth \
  --set durationOfEachRequest=200 \
  --set sizeOfMemoryAllocated=512MB
```

3. Add `--share` to publish a public URL:

```sh
awscalc price --service amazonS3Standard --region eu-west-1 \
  --set s3StandardStorageSize=5TB \
  --set s3StandardGetRequests=2000000 \
  --share
```

Grouped services (S3, DynamoDB, EMR, SNS, Glue, Backup, Step Functions, SageMaker) accept `--subservice`:

```sh
awscalc price --service s3 \
  --subservice amazonS3Standard \
  --subservice amazonS3StandardInfrequentAccess \
  --set s3StandardStorageSize=100GB \
  --set s3IaStorageSize=50GB \
  --share
```

Read a published estimate back:

```sh
awscalc get https://calculator.aws/#/estimate?id=<id>
```

## Value syntax

- File size: `100GB`, `5TB/month`, `512MB`
- Frequency: `10millionPerMonth`, `2millionPerMonth`, `100perSecond`, `730hours`
- Duration: `5min`, `200ms`, `30day`
- Dropdown: id or label, e.g. `selectArchitecture=x86`
- Percent: `100` (meaning 100%)

If a unit is invalid for that input, the command fails and lists the valid units.

## Notes

- Pricing is USD only (the public calculator maps are USD).
- `--json` returns raw JSON; default output is TOON.
- `--refresh` bypasses the 6–24 hour cache; `--offline` requires it.
- Unsupported calculator widgets (EC2 instance pricing, RDS/Aurora/ElastiCache/MSK and other PLC 2.0 services) fail loudly with `UNSUPPORTED_SERVICE`; do not assume a `0` price means free.
- The published URL stores the full configuration. Open it and press **Update estimate** to verify the calculator recomputes the same total.
