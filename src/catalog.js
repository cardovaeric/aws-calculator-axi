import { AxiError } from "axi-sdk-js";

import { fetchJson } from "./http.js";
import { REGION_NAMES } from "./regions.js";

export const MANIFEST_URL =
  "https://d1qsjq9pzbk1k6.cloudfront.net/manifest/en_US.json";

// Friendly aliases for the services agents reach for most often. Each maps to
// the calculator's serviceCode (or sub-service code).
export const ALIASES = {
  lambda: "aWSLambda",
  s3: "amazonSimpleStorageServiceGroup",
  "s3-standard": "amazonS3Standard",
  "s3-ia": "amazonS3StandardInfrequentAccess",
  "s3-onezone-ia": "s3OneZoneInfrequentAccess",
  "s3-glacier-ir": "s3GlacierInstantRetrieval",
  "s3-glacier-flexible": "amazonS3Glacier",
  "s3-glacier-deep-archive": "amazonS3GlacierDeepArhive",
  "s3-intelligent-tiering": "amazonS3IntelligentTiering",
  cloudfront: "amazonCloudFront",
  dynamodb: "amazonDynamoDb",
  "dynamodb-ondemand": "dynamoDbOnDemand",
  "dynamodb-provisioned": "amazonDynamoDbProvisionedThroughputCapacity",
  "api-gateway": "amazonApiGateway",
  sqs: "amazonSimpleQueueService",
  sns: "standardTopics",
  "sns-standard": "standardTopics",
  "sns-fifo": "fifoTopics",
  kinesis: "amazonKinesisDataStreams",
  cloudwatch: "amazonCloudWatch",
  fargate: "awsFargate",
  eks: "awsEks",
  ecr: "amazonElasticContainerRegistry",
  codebuild: "awsCodeBuild",
  "route53": "amazonRoute53",
  eventbridge: "amazonEventBridge",
  kms: "awsKeyManagementService",
  "secrets-manager": "awsSecretsManager",
  efs: "amazonEFS",
  ebs: "amazonElasticBlockStore",
  "elastic-ip": "publicIpv4Address",
  "public-ipv4": "publicIpv4Address",
  alb: "applicationLoadBalancer",
  nlb: "networkLoadBalancer",
  "nat-gateway": "networkAddressTranslationNatGatewayVpc",
  "transit-gateway": "transitGatewayVpc",
  "vpc-endpoint": "awsPrivateLinkVpc",
  aurora: "amazonAuroraMySQLCompatible",
  "aurora-mysql": "amazonAuroraMySQLCompatible",
  "aurora-postgresql": "amazonRDSAuroraPostgreSQLCompatibleDB",
  rds: "amazonRDSMySQLDB",
  "rds-mysql": "amazonRDSMySQLDB",
  "rds-postgresql": "amazonRDSPostgreSQLDB",
  "rds-mariadb": "amazonRDSMariaDB",
  "rds-sqlserver": "amazonRDSForSQLServer",
  "rds-oracle": "amazonRdsForOracle",
  elasticache: "amazonElastiCache",
  opensearch: "amazonElasticsearchService",
  redshift: "amazonRedshift",
  athena: "amazonAthena",
  glue: "awsGlue",
  emr: "amazonEMR",
  msk: "amazonManagedStreamingForApacheKafkaMsk",
  documentdb: "amazonDocumentDB",
  neptune: "amazonNeptune",
  timestream: "amazonTimestream",
  keyspaces: "amazonKeyspaces",
  memorydb: "amazonMemoryDbForRedis",
  backup: "awsBackup",
  "step-functions": "awsStepFunctions",
  bedrock: "amazonBedrock",
  sagemaker: "amazonSageMaker",
  transfer: "aWSTransferForSFTP",
  waf: "awsWebApplicationFirewall",
  shield: "awsShield",
  cloudtrail: "awsCloudTrail",
  config: "awsConfig",
  inspector: "amazonInspector",
  guardduty: "amazonGuardDuty",
  cognito: "amazonCognito",
  xray: "awsXRay",
  "direct-connect": "awsDirectConnect",
  "site-to-site-vpn": "vpnConnectionVpc",
  "network-firewall": "amazonNetworkFirewall",
  "fsx-windows": "amazonFSx",
  "fsx-lustre": "amazonFSxForLustre",
  "fsx-ontap": "amazonFSxForNetAppOntap",
  "fsx-openzfs": "amazonFSxForOpenZfs",
  "elastic-transcoder": "amazonElasticTranscoder",
  "codecommit": "awsCodeCommit",
  "codepipeline": "awsCodePipeline",
  codedeploy: "awsCodeDeploy",
};

function normalizeName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function loadManifest(options = {}) {
  const manifest = await fetchJson(MANIFEST_URL, {
    ttlMs: 6 * 60 * 60 * 1000,
    ...options,
  });
  const services = manifest.awsServices ?? [];
  return services
    .filter((service) => service.isActive !== "false")
    .map((service) => ({
      code: service.serviceCode,
      name: service.name.trim(),
      description: service.description,
      regions: service.regions ?? [],
      linkUrl: service.linkUrl,
      definitionUrl: service.serviceDefinitionLocation,
      subType: service.subType,
      type: service.type,
      slug: service.slug,
      mvp: service.MVPSupport,
      c2e: service.c2e,
    }));
}

/** Find a service by code, alias, slug, or (partial) display name. */
export async function findService(query, options = {}) {
  const services = await loadManifest(options);
  const q = String(query ?? "").trim();
  if (!q) {
    throw new AxiError("--service is required", "VALIDATION_ERROR", [
      "Run `awscalc services` to list service codes",
    ]);
  }
  if (ALIASES[q.toLowerCase()]) {
    const code = ALIASES[q.toLowerCase()];
    const hit = services.find((service) => service.code === code);
    if (hit) return hit;
  }
  const lower = q.toLowerCase();
  const exact =
    services.find((service) => service.code.toLowerCase() === lower) ??
    services.find((service) => normalizeName(service.name) === normalizeName(q));
  if (exact) return exact;

  const matches = services.filter(
    (service) =>
      service.code.toLowerCase().includes(lower) ||
      normalizeName(service.name).includes(normalizeName(q)),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const exactCodePrefix = matches.filter((service) =>
      service.code.toLowerCase().startsWith(lower),
    );
    if (exactCodePrefix.length === 1) return exactCodePrefix[0];
    throw new AxiError(`Service "${q}" is ambiguous`, "VALIDATION_ERROR", [
      `Matches: ${matches
        .slice(0, 12)
        .map((service) => service.code)
        .join(", ")}`,
      "Pass the exact serviceCode",
    ]);
  }
  throw new AxiError(`Unknown service: ${q}`, "VALIDATION_ERROR", [
    "Run `awscalc services --filter <text>` to search the catalog",
    `Aliases include: ${Object.keys(ALIASES).slice(0, 10).join(", ")}`,
  ]);
}

export async function loadDefinition(service, options = {}) {
  if (!service.definitionUrl) {
    throw new AxiError(
      `No definition URL for ${service.code}`,
      "UPSTREAM_ERROR",
    );
  }
  return fetchJson(service.definitionUrl, {
    ttlMs: 24 * 60 * 60 * 1000,
    ...options,
  });
}

export function serviceRegions(service, definition) {
  const codes = new Set(definition?.regions?.length ? definition.regions : service.regions);
  return [...codes]
    .filter((code) => REGION_NAMES[code])
    .map((code) => ({ code, name: REGION_NAMES[code] }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
