import { readFile } from "node:fs/promises";

import { commandDrift, parseCommands } from "../src/commands.js";

/**
 * Register the application commands, or check them (DC-007):
 * `--schema` checks `commands/commands.json` against Discord's
 * limits, offline (CI); `--check` also compares it with what the
 * application has registered and fails on any difference; with neither, one
 * bulk overwrite (`PUT /applications/{id}/commands`, or the guild's with
 * `--guild <id>` in development) registers them. Reads
 * DATALAYER_DISCORD_APPLICATION_ID and DATALAYER_DISCORD_BOT_TOKEN; prints neither.
 */
const API = "https://discord.com/api/v10";
const argv = process.argv.slice(2);
const guildAt = argv.indexOf("--guild");
const guild = guildAt >= 0 ? argv[guildAt + 1] : undefined;
if (guildAt >= 0 && !/^\d{17,20}$/.test(guild ?? "")) {
  console.error("--guild takes a server id.");
  process.exit(1);
}
const commands = parseCommands(
  JSON.parse(
    await readFile(
      new URL("../commands/commands.json", import.meta.url),
      "utf8",
    ),
  ),
);
if (argv.includes("--schema")) {
  console.info(`${commands.length} commands defined, within Discord's limits.`);
  process.exit(0);
}
const application = process.env.DATALAYER_DISCORD_APPLICATION_ID;
const token = process.env.DATALAYER_DISCORD_BOT_TOKEN;
if (!application || !token) {
  console.error(
    "DATALAYER_DISCORD_APPLICATION_ID and DATALAYER_DISCORD_BOT_TOKEN are required.",
  );
  process.exit(1);
}
const url = `${API}/applications/${application}${guild ? `/guilds/${guild}` : ""}/commands`;
const headers = {
  authorization: `Bot ${token}`,
  "content-type": "application/json",
};
if (argv.includes("--check")) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    console.error(`Discord did not list the commands (${response.status}).`);
    process.exit(1);
  }
  const drift = commandDrift(
    commands,
    (await response.json()) as Record<string, unknown>[],
  );
  if (drift.length) {
    console.error(`The registered commands differ:\n${drift.join("\n")}`);
    process.exit(1);
  }
  console.info(`${commands.length} commands registered as defined.`);
} else {
  // One bulk overwrite: never a create per command, so the 200 creates a
  // day per guild are never spent in a loop.
  const response = await fetch(url, {
    body: JSON.stringify(commands),
    headers,
    method: "PUT",
  });
  if (!response.ok) {
    console.error(`Discord refused the commands (${response.status}).`);
    process.exit(1);
  }
  console.info(
    `${commands.length} commands registered${guild ? " in the server" : ""}.`,
  );
}
