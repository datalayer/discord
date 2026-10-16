import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Standalone CI and the image only (DC-004): put the
 * pinned agent-runtimes release's `lib/portable` — and nothing else of it —
 * at `node_modules/@datalayer/agent-runtimes`, so that the service bundles
 * its hosts entry without installing agent-runtimes' Jupyter and React
 * tree. In the monorepo the workspace link serves it (the user's watcher
 * builds `lib/portable`), and this refuses to run. `npm install` removes
 * what this extracts: run it after every install.
 */
const version = process.env.npm_package_config_agentRuntimesVersion;
if (!version) {
  console.error(
    "Run it as `npm run fetch:agent-runtimes`: config.agentRuntimesVersion names the release.",
  );
  process.exit(1);
}
const target = join("node_modules", "@datalayer", "agent-runtimes");
if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
  console.error(
    `${target} is the monorepo's workspace link: lib/portable comes from the watcher there.`,
  );
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "agent-runtimes-"));
try {
  const tarball = execFileSync(
    "npm",
    ["pack", `@datalayer/agent-runtimes@${version}`, "--silent"],
    { cwd: work, encoding: "utf8" },
  ).trim();
  execFileSync("tar", [
    "-xzf",
    join(work, tarball),
    "-C",
    work,
    "package/package.json",
    "package/lib/portable",
  ]);
  rmSync(target, { force: true, recursive: true });
  mkdirSync(join(target, "lib"), { recursive: true });
  execFileSync("cp", [
    "-R",
    join(work, "package", "lib", "portable"),
    join(target, "lib", "portable"),
  ]);
  const { name, type } = JSON.parse(
    readFileSync(join(work, "package", "package.json"), "utf8"),
  );
  // Its name, version and module type only: its dependencies are not
  // installed, and `npm ls` would report each as missing.
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify({ name, version, type }, null, 2)}\n`,
  );
  for (const file of [
    "lib/portable/hosts/index.js",
    "lib/portable/hosts/contracts.json",
    "lib/portable/semantic-events.json",
  ])
    if (!existsSync(join(target, file))) {
      console.error(
        `@datalayer/agent-runtimes@${version} has no ${file}: pin a release that carries the hosts entry.`,
      );
      process.exit(1);
    }
  console.info(
    `@datalayer/agent-runtimes@${version}: lib/portable extracted to ${target}.`,
  );
} finally {
  rmSync(work, { force: true, recursive: true });
}
