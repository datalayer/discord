import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  applicationDrift,
  applicationSettingsFor,
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
  it("reads an optional option Discord answers without `required` as `required: false` (/ask as registered on Datalayer Dev)", async () => {
    const commands = await defined();
    // GET /applications/{id}/commands, 16 October 2026: /ask's two optional
    // options come back without `required`.
    const ask = {
      id: "1560672689478434926",
      application_id: "1467061572630347817",
      version: "1560672689478434930",
      default_member_permissions: null,
      type: 1,
      name: "ask",
      description: "Ask a Datalayer application",
      dm_permission: true,
      contexts: [0, 1],
      integration_types: [0],
      options: [
        {
          type: 3,
          name: "question",
          description: "What to ask",
          required: true,
          min_length: 1,
          max_length: 6000,
        },
        {
          type: 3,
          name: "application",
          description:
            "The application that answers (default: this thread's or your default)",
          autocomplete: true,
        },
        { type: 5, name: "private", description: "Answer only to you" },
      ],
      nsfw: false,
    };
    const rest = commands
      .filter((one) => one.name !== "ask")
      .map((one) => ({
        ...one,
        ...(one.type === 3 ? { description: "" } : {}),
      }));
    expect(commandDrift(commands, [ask, ...rest])).toEqual([]);
    // A required option registered as optional is still drift.
    const loose = {
      ...ask,
      options: ask.options.map((one) =>
        Object.fromEntries(
          Object.entries(one).filter(([key]) => key !== "required"),
        ),
      ),
    };
    expect(commandDrift(commands, [loose, ...rest])).toEqual([
      "ask: registered differently",
    ]);
  });
});

describe("the application's settings (DC-007)", () => {
  const definition = async (): Promise<unknown> =>
    JSON.parse(
      await readFile(
        new URL("../commands/application.json", import.meta.url),
        "utf8",
      ),
    );

  it("fills the origin and the Public Bot switch, and refuses an origin with a path", async () => {
    const dev = applicationSettingsFor(
      await definition(),
      "https://discord-dev.datalayer.run",
      false,
    );
    expect(dev).toMatchObject({
      interactions_endpoint_url:
        "https://discord-dev.datalayer.run/discord/interactions",
      event_webhooks_url: "https://discord-dev.datalayer.run/discord/events",
      redirect_uris: [
        "https://discord-dev.datalayer.run/discord/oauth/callback",
      ],
      custom_install_url: "https://discord-dev.datalayer.run/discord/install",
      bot_public: false,
      bot_require_code_grant: true,
    });
    expect(
      applicationSettingsFor(
        await definition(),
        "https://discord.datalayer.run",
        true,
      ).bot_public,
    ).toBe(true);
    const value = await definition();
    expect(() =>
      applicationSettingsFor(
        value,
        "https://discord-dev.datalayer.run/x",
        false,
      ),
    ).toThrow(/no path/);
  });

  it("names each setting Discord holds differently (Datalayer Dev's Bot page, 16 October 2026)", async () => {
    const dev = applicationSettingsFor(
      await definition(),
      "https://discord-dev.datalayer.run",
      false,
    );
    // GET /applications/@me, the fields the definition holds.
    const live = {
      id: "1467061572630347817",
      name: "Datalayer DEV",
      interactions_endpoint_url:
        "https://discord-dev.datalayer.run/discord/interactions",
      event_webhooks_url: "https://discord-dev.datalayer.run/discord/events",
      event_webhooks_status: 2,
      event_webhooks_types: ["APPLICATION_AUTHORIZED"],
      redirect_uris: [
        "https://discord-dev.datalayer.run/discord/oauth/callback",
      ],
      custom_install_url: "https://discord-dev.datalayer.run/discord/install",
      install_params: null,
      integration_types_config: { "0": {} },
      terms_of_service_url: "https://datalayer.ai/terms",
      privacy_policy_url: "https://datalayer.ai/privacy",
      bot_public: true,
      bot_require_code_grant: false,
    };
    expect(applicationDrift(dev, live)).toEqual([
      "bot_public: true, defined false",
      "bot_require_code_grant: false, defined true",
    ]);
    expect(
      applicationDrift(dev, {
        ...live,
        bot_public: false,
        bot_require_code_grant: true,
      }),
    ).toEqual([]);
    expect(
      applicationDrift(dev, {
        ...live,
        bot_public: false,
        bot_require_code_grant: true,
        event_webhooks_status: 1,
        integration_types_config: { "0": {}, "1": {} },
      }),
    ).toEqual([
      "event_webhooks_status: 1, defined 2",
      'integration_types_config: {"0":{},"1":{}}, defined {"0":{}}',
    ]);
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
