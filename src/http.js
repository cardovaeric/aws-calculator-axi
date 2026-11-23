import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";

import { VERSION } from "./version.js";

export const CACHE_DIR =
  process.env.AWSCALC_CACHE_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "awscalc");

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const inflight = new Map();

function cachePath(url) {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 24);
  return join(CACHE_DIR, `${hash}.json`);
}

async function readCache(url) {
  try {
    const raw = await readFile(cachePath(url), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(url, body) {
  const path = cachePath(url);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ url, fetchedAt: Date.now(), body }));
  await rename(tmp, path);
}

/**
 * Fetch JSON with an on-disk cache.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {boolean} [options.refresh]
 * @param {boolean} [options.offline]
 * @param {number} [options.retries]
 */
export async function fetchJson(url, options = {}) {
  const {
    ttlMs = DEFAULT_TTL_MS,
    refresh = false,
    offline = false,
    retries = 2,
  } = options;

  const cached = refresh ? null : await readCache(url);
  if (cached && Date.now() - cached.fetchedAt <= ttlMs) return cached.body;
  if (offline) {
    if (cached) return cached.body;
    throw new AxiError(
      `No cached pricing data for ${url}`,
      "NETWORK_ERROR",
      ["Re-run without --offline to fetch fresh pricing data"],
    );
  }
  if (inflight.has(url)) return inflight.get(url);

  const task = (async () => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            accept: "application/json, text/plain, */*",
            "user-agent": `awscalc/${VERSION}`,
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) {
          const body = await response.json();
          await writeCache(url, body);
          return body;
        }
        if (response.status === 403 || response.status === 404) {
          throw new AxiError(
            `Pricing data is unavailable (HTTP ${response.status})`,
            "UPSTREAM_ERROR",
            ["Run `awscalc services --refresh` to reload the service catalog"],
          );
        }
        lastError = new Error(`HTTP ${response.status} for ${url}`);
      } catch (error) {
        if (error instanceof AxiError) throw error;
        lastError = error;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
    if (cached) return cached.body;
    throw new AxiError(
      `Could not fetch pricing data: ${lastError?.message ?? "unknown error"}`,
      "NETWORK_ERROR",
      ["Check network access to calculator.aws", "Re-run without --offline"],
    );
  })().finally(() => inflight.delete(url));

  inflight.set(url, task);
  return task;
}
