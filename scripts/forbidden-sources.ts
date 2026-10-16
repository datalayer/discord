import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import {
  importsOf,
  isForbidden,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * What the service's own sources may not import (S-005, DC-004):
 * the shared forbidden list, and agent-runtimes' portable
 * entry itself, whose types reach Reactor — the service imports only its
 * hosts entry (`@datalayer/agent-runtimes/lib/portable/hosts`).
 */
const PORTABLE_ENTRY =
  /["']@datalayer\/agent-runtimes\/lib\/portable["']|["']@datalayer\/agent-runtimes["']/;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

/** The forbidden imports of the production sources under `directory`. */
export async function forbiddenInSources(directory = "src"): Promise<string[]> {
  const violations: string[] = [];
  for (const path of await files(directory)) {
    if (![".ts", ".tsx", ".js", ".mjs"].includes(extname(path))) continue;
    const source = await readFile(path, "utf8");
    for (const name of importsOf(source))
      if (isForbidden(name)) violations.push(`${path}: ${name}`);
    if (PORTABLE_ENTRY.test(source))
      violations.push(
        `${path}: imports agent-runtimes beyond lib/portable/hosts`,
      );
  }
  return violations;
}
