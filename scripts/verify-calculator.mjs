import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION = process.env.AGENT_BROWSER_SESSION ?? "awscalc-verify";

function runCli(args) {
  return execFileAsync(
    process.execPath,
    [join(ROOT, "bin", "awscalc.js"), "price", ...args, "--share", "--json", "--name", "verify"],
    { cwd: ROOT, env: process.env },
  );
}

function browser(args, input) {
  return execFileSync("agent-browser", args, {
    env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
    input,
    encoding: "utf8",
    timeout: 90_000,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function recompute(url) {
  const seed = Math.floor(Math.random() * 1e9);
  const target = url.replace(
    "https://calculator.aws/#/estimate?id=",
    `https://calculator.aws/?verify=${seed}#/estimate?id=`,
  );
  browser(["open", target]);
  await sleep(5000);
  try {
    browser(
      ["eval", "--stdin"],
      '[...document.querySelectorAll("button")].filter(b=>/Update estimate/i.test(b.textContent))[0]?.click(); "ok"',
    );
  } catch {
    // Best effort: some pages are already editable.
  }
  await sleep(5000);
  const text = browser(["get", "text", "body"]);
  const monthly = text.match(/Monthly cost\s*\n\s*([\d,]+\.\d+)\s*USD/);
  const upfront = text.match(/Upfront cost\s*\n\s*([\d,]+\.\d+)\s*USD/);
  return {
    monthly: monthly ? Number(monthly[1].replace(/,/g, "")) : null,
    upfront: upfront ? Number(upfront[1].replace(/,/g, "")) : null,
  };
}

const casesPath = process.argv[2] ?? join(ROOT, "test", "calculator-cases.json");
const cases = JSON.parse(await readFile(casesPath, "utf8"));
let failures = 0;

for (const testCase of cases) {
  const label = testCase.label ?? testCase.args.join(" ");
  try {
    const { stdout } = await runCli(testCase.args);
    const estimate = JSON.parse(stdout);
    const actual = await recompute(estimate.url);
    const okMonthly =
      actual.monthly != null &&
      Math.abs(actual.monthly - Number(estimate.monthly)) < 0.005;
    const okUpfront =
      actual.upfront == null ||
      Math.abs(actual.upfront - Number(estimate.upfront)) < 0.005;
    if (okMonthly && okUpfront) {
      console.log(`OK   ${label}  monthly=${estimate.monthly} upfront=${estimate.upfront}`);
    } else {
      failures += 1;
      console.log(
        `FAIL ${label}  cli=${estimate.monthly}/${estimate.upfront} calculator=${actual.monthly}/${actual.upfront}`,
      );
      console.log(`     ${estimate.url}`);
    }
  } catch (error) {
    failures += 1;
    console.log(`ERR  ${label}: ${error.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} calculator parity check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${cases.length} calculator parity checks passed`);
}
