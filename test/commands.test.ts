import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  commandDrift,
  parseCommands,
  type CommandDefinition,
} from "../src/commands.js";
import {
  BOT_PERMISSIONS,
  missingPermissions,
  permissionsInteger,
} from "../src/permissions.js";

const defined = async (): Promise<CommandDefinition[]> =>
  parseCommands(
    JSON.parse(
      await readFile(
        new URL("../commands/commands.json", import.meta.url),
        "utf8",
      ),
    ),
  );

describe("the application commands (DC-007)", () => {
  it("defines /ask, /datalayer, /datalayer-admin and Ask Datalayer, guild install only, within Discord's limits", async () => {
    const commands = await defined();
    expect(commands.map((one) => one.name)).toEqual([
      "ask",
      "datalayer",
      "datalayer-admin",
      "Ask Datalayer",
    ]);
    for (const command of commands)
      expect(command.integration_types).toEqual([0]);
    const admin = commands.find((one) => one.name === "datalayer-admin");
    // Guild only, and Manage Server by default (Datalayer still decides).
    expect(admin).toMatchObject({
      contexts: [0],
      default_member_permissions: "32",
    });
    const ask = commands.find((one) => one.name === "ask");
    expect(JSON.stringify(ask)).toContain('"max_length":6000');
  });

  it("refuses a definition Discord would refuse", () => {
    const ask = {
      name: "ask",
      type: 1,
      description: "x",
      integration_types: [0],
      contexts: [0],
    };
    expect(() => parseCommands([{ ...ask, name: "Ask" }])).toThrow();
    expect(() => parseCommands([{ ...ask, description: "" }])).toThrow();
    expect(() =>
      parseCommands([{ ...ask, integration_types: [0, 1] }]),
    ).toThrow();
    expect(() => parseCommands([ask, ask])).toThrow(/defined twice/);
    expect(() => parseCommands([{ ...ask, unknown: true }])).toThrow();
  });

  it("finds what is registered differently, missing or extra", async () => {
    const commands = await defined();
    const registered = commands.map((one) => ({
      ...one,
      id: "1",
      application_id: "2",
      version: "3",
      ...(one.type === 3 ? { description: "" } : {}),
    }));
    expect(commandDrift(commands, registered)).toEqual([]);
    expect(
      commandDrift(commands, [
        ...registered.slice(1),
        { name: "old", type: 1, description: "gone" },
      ]),
    ).toEqual(["ask: not registered", "old: registered, not defined"]);
    expect(
      commandDrift(commands, [
        { ...registered[0], description: "changed" },
        ...registered.slice(1),
      ]),
    ).toEqual(["ask: registered differently"]);
  });
});

describe("the bot's permissions (DC-007)", () => {
  it("is the integer computed from the table: 309237763136, without USE_APPLICATION_COMMANDS", () => {
    expect(permissionsInteger()).toBe("309237763136");
    expect(BOT_PERMISSIONS.map((one) => one.name)).not.toContain(
      "USE_APPLICATION_COMMANDS",
    );
    // With it, the other candidate.
    expect(
      permissionsInteger([
        ...BOT_PERMISSIONS,
        { name: "USE_APPLICATION_COMMANDS", bit: 1n << 31n, why: "" },
      ]),
    ).toBe("311385246784");
  });

  it("asks for no administrator, manage, mention-everyone or private-thread permission", () => {
    const asked = BigInt(permissionsInteger());
    for (const bit of [3n, 4n, 5n, 13n, 17n, 28n, 36n])
      expect(asked & (1n << bit), String(bit)).toBe(0n);
  });

  it("says which asked permissions a place lacks", () => {
    const granted = String((1n << 10n) | (1n << 11n));
    expect(
      missingPermissions(granted, [
        "VIEW_CHANNEL",
        "SEND_MESSAGES",
        "SEND_MESSAGES_IN_THREADS",
      ]),
    ).toEqual(["SEND_MESSAGES_IN_THREADS"]);
    expect(() => missingPermissions(granted, ["ADMINISTRATOR"])).toThrow(
      /Not a permission/,
    );
  });
});
