#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";

import { VERSION } from "../src/version.js"; // leaf module - node builtins only

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../src/cli.js"); // heavy graph loads only here
  await main();
}
