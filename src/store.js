import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HISTORY_PATH =
  process.env.AWSCALC_HISTORY_PATH ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "awscalc", "history.json");

const MAX_ENTRIES = 100;

export async function readHistory() {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export async function recordEstimate(entry) {
  const entries = await readHistory();
  const next = [
    { ...entry, at: new Date().toISOString() },
    ...entries.filter((item) => item.url !== entry.url),
  ].slice(0, MAX_ENTRIES);
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify({ entries: next }, null, 2));
  return next;
}

export function recentForCwd(entries, cwd, limit = 3) {
  return entries.filter((entry) => entry.cwd === cwd).slice(0, limit);
}

export function historyPath() {
  return HISTORY_PATH;
}
