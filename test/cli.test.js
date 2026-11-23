import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "awscalc.js");

const MANIFEST_URL =
  "https://d1qsjq9pzbk1k6.cloudfront.net/manifest/en_US.json";
const DEFINITION_URL = "https://example.test/testService/en_US.json";
const PRICE_URL =
  "https://calculator.aws/pricing/2.0/meteredUnitMaps/test/USD/current/test.json";
const REGION_LIST_URL =
  "https://example.test/testService/regionList/publish.json";

const definition = {
  version: "1.0.0",
  serviceName: "Test Service",
  serviceCode: "testService",
  mappingDefinitions: [
    {
      mappingDefinitionName: "test",
      mappingDefinitionURL:
        "pricing/2.0/meteredUnitMaps/test/[currency]/current/test.json",
    },
  ],
  templates: [
    {
      id: "main",
      title: "Main",
      cards: [
        {
          title: "Storage",
          inputSection: {
            components: [
              {
                type: "input",
                subType: "fileSize",
                id: "storage",
                label: "Storage",
                dropDownSize: [
                  { id: "gb", label: "GB" },
                  { id: "tb", label: "TB" },
                ],
                dropDownFrequency: [{ id: "month", label: "month" }],
                defaultOption: { size: "gb", frequency: "month" },
                outputSize: "gb",
                outputFrequency: "month",
                displayInConfigSummary: true,
                defaultValue: 10,
              },
              {
                type: "pricing",
                subType: "singlePricePoint",
                id: "price",
                mappingDefinitionName: "test",
                meteredUnit: { allRegions: "Storage GB" },
              },
            ],
          },
          mathsSection: [
            {
              components: [
                {
                  type: "maths",
                  subType: "basicMaths",
                  operation: "multiplication",
                  id: "cost",
                  decimalPlaces: 2,
                  operands: [{ variableId: "storage" }, { variableId: "price" }],
                },
                {
                  type: "display",
                  subType: "priceDisplay",
                  costType: "Monthly",
                  label: "Storage cost",
                  id: "costDisplay",
                  subTotalRefer: "cost",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function cacheFixture() {
  const dir = await mkdtemp(join(tmpdir(), "awscalc-cache-"));
  const write = async (url, body) => {
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 24);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${hash}.json`),
      JSON.stringify({ url, fetchedAt: Date.now(), body }),
    );
  };
  await write(MANIFEST_URL, {
    awsServices: [
      {
        serviceCode: "testService",
        name: "Test Service",
        isActive: "true",
        type: "AWSService",
        regions: ["us-east-1"],
        serviceDefinitionLocation: DEFINITION_URL,
        linkUrl: "https://example.test",
      },
    ],
  });
  await write(DEFINITION_URL, definition);
  await write(PRICE_URL, {
    regions: {
      "US East (N. Virginia)": {
        "Storage GB": { price: "0.023" },
      },
    },
  });
  await write(REGION_LIST_URL, {
    inclusionList: ["us-east-1"],
    exclusionList: [],
    overwriteInclusionList: [],
    overwriteExclusionList: [],
  });
  return dir;
}

async function runCli(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    return { stdout, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
}

test("prices a service end to end from cached calculator data", async () => {
  const dir = await cacheFixture();
  const history = join(dir, "history.json");
  const env = {
    AWSCALC_CACHE_DIR: dir,
    AWSCALC_HISTORY_PATH: history,
  };
  const { stdout, code } = await runCli(
    [
      "price",
      "--service",
      "testService",
      "--region",
      "us-east-1",
      "--set",
      "storage=100GB",
      "--offline",
    ],
    env,
  );
  assert.equal(code, 0, stdout);
  assert.match(stdout, /monthly: 2\.3/);
  assert.match(stdout, /summary: "?Storage \(100 GB per month\)"?/);
});

test("lists catalog entries from cached data", async () => {
  const dir = await cacheFixture();
  const env = { AWSCALC_CACHE_DIR: dir, AWSCALC_HISTORY_PATH: join(dir, "h.json") };
  const { stdout, code } = await runCli(["services", "--filter", "test", "--offline"], env);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /testService/);
  assert.match(stdout, /count: 1 of 1 services/);
});

test("rejects regions where the calculator does not offer the service", async () => {
  const dir = await cacheFixture();
  const env = { AWSCALC_CACHE_DIR: dir, AWSCALC_HISTORY_PATH: join(dir, "h.json") };
  const { stdout, code } = await runCli(
    [
      "price",
      "--service",
      "testService",
      "--region",
      "eu-west-1",
      "--set",
      "storage=100GB",
      "--offline",
    ],
    env,
  );
  assert.equal(code, 2, stdout);
  assert.match(stdout, /not offered in eu-west-1/);
  assert.match(stdout, /Available: us-east-1/);
});

test("lists the calculator's per-service region list", async () => {
  const dir = await cacheFixture();
  const env = { AWSCALC_CACHE_DIR: dir, AWSCALC_HISTORY_PATH: join(dir, "h.json") };
  const { stdout, code } = await runCli(
    ["regions", "--service", "testService", "--offline"],
    env,
  );
  assert.equal(code, 0, stdout);
  assert.match(stdout, /count: 1/);
  assert.match(stdout, /us-east-1,US East \(N\. Virginia\)/);
});

test("rejects unknown flags with exit code 2 and the valid flag list", async () => {
  const { stdout, code } = await runCli(["services", "--stat", "open"], {
    AWSCALC_HISTORY_PATH: join(tmpdir(), "awscalc-missing-history.json"),
  });
  assert.equal(code, 2);
  assert.match(stdout, /unknown flag --stat/);
  assert.match(stdout, /--filter/);
});

test("home view states definitively when no estimates exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awscalc-home-"));
  const { stdout, code } = await runCli([], {
    AWSCALC_HISTORY_PATH: join(dir, "history.json"),
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no estimates saved from this directory yet/);
  assert.match(stdout, /^bin: /m);
});

test("--version fast path prints the version and exits 0", async () => {
  const { stdout, code } = await runCli(["--version"], {});
  assert.equal(code, 0);
  assert.equal(stdout, "0.1.0\n");
});
