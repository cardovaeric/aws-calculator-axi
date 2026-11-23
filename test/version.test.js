import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "awscalc.js");

test("VERSION matches package.json", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
});

async function medianMs(run, samples = 5) {
  const times = [];
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

test("--version stays close to the node startup floor", async () => {
  const floor = await medianMs(() =>
    execFileAsync(process.execPath, ["-e", "console.log(1)"]),
  );
  const version = await medianMs(() =>
    execFileAsync(process.execPath, [BIN, "--version"]),
  );
  // The fast path must not load the command graph. Compare against a measured
  // floor rather than an absolute budget so slow machines do not flake.
  assert.ok(
    version <= floor + 500,
    `--version took ${version.toFixed(1)}ms vs floor ${floor.toFixed(1)}ms`,
  );
});
