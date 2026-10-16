import { execFileSync } from "node:child_process";

import {
  forbiddenInInstalled,
  installedGraph,
  type InstalledTree,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * The installed graph of the bundle's externals, as the image's runtime
 * stage installs it (`npm install --omit=dev`; agent-runtimes, an optional
 * peer, is never installed — npm installs no optional peer): no forbidden
 * package (S-005, DC-004). Run in CI from the
 * standalone repository, never from the monorepo root, whose extraneous
 * packages it would count.
 */
let tree: InstalledTree;
try {
  tree = JSON.parse(
    execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  ) as InstalledTree;
} catch (error) {
  // npm ls exits 1 on a problem it still describes in its JSON.
  const stdout = (error as { stdout?: string }).stdout;
  if (!stdout) {
    console.error("npm ls did not answer: install the dependencies first.");
    process.exit(1);
  }
  tree = JSON.parse(stdout) as InstalledTree;
}
const forbidden = forbiddenInInstalled(tree);
if (forbidden.length) {
  console.error(
    `Forbidden packages in the production graph:\n${forbidden.join("\n")}`,
  );
  process.exitCode = 1;
} else {
  const names = new Set(installedGraph(tree).map((one) => one.name));
  console.info(
    `No forbidden package: ${names.size} production packages checked.`,
  );
}
