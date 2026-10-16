import { describe, expect, it } from "vitest";

import { readConfig, SETTINGS } from "../src/config.js";
import { ENVIRONMENT } from "./support/environment.js";

describe("the configuration (DC-008)", () => {
  it("reads a complete environment, with its few defaults", () => {
    const config = readConfig(ENVIRONMENT);
    expect(config).toMatchObject({
      DATALAYER_DELIVERY_POLL_SECONDS: 30,
      DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY_VERSION: 1,
      PORT: 3000,
    });
    expect(config.DATABASE_URL).toBeUndefined();
  });

  it.each([
    "DATALAYER_DISCORD_APPLICATION_ID",
    "DATALAYER_DISCORD_PUBLIC_KEY",
    "DATALAYER_DISCORD_BOT_TOKEN",
    "DATALAYER_DISCORD_CLIENT_SECRET",
    "DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY",
    "DATALAYER_DISCORD_APP_URL",
    "DATALAYER_API_URL",
    "DATALAYER_DISCORD_ROLE",
    "NODE_ENV",
  ])("refuses to start without %s, naming it", (name) => {
    const environment: Record<string, string> = { ...ENVIRONMENT };
    delete environment[name];
    expect(() => readConfig(environment)).toThrow(
      new RegExp(
        `^@Datalayer for Discord cannot start:\\n(.*\\n)*${name}: missing`,
      ),
    );
  });

  it("refuses a malformed id, key or address by name, with what it should be", () => {
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_DISCORD_APPLICATION_ID: "app" }),
    ).toThrow(/DATALAYER_DISCORD_APPLICATION_ID: a Discord id/);
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_DISCORD_PUBLIC_KEY: "ABC" }),
    ).toThrow(/DATALAYER_DISCORD_PUBLIC_KEY: 64 lowercase hex characters/);
    expect(() =>
      readConfig({
        ...ENVIRONMENT,
        DATALAYER_DISCORD_APP_URL: "http://plain.example",
      }),
    ).toThrow(/DATALAYER_DISCORD_APP_URL/);
  });

  it("refuses production, or a split role, without PostgreSQL", () => {
    expect(() =>
      readConfig({ ...ENVIRONMENT, NODE_ENV: "production" }),
    ).toThrow(/DATABASE_URL: production keeps its work in PostgreSQL/);
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_DISCORD_ROLE: "worker" }),
    ).toThrow(/DATABASE_URL: the worker role shares its durable queue/);
    expect(
      readConfig({
        ...ENVIRONMENT,
        DATABASE_URL: "postgres://x@localhost/discord",
        NODE_ENV: "production",
      }).NODE_ENV,
    ).toBe("production");
  });

  it("names every setting the README documents", async () => {
    const { readFile } = await import("node:fs/promises");
    const guide = await readFile(
      new URL("../docs/operations.md", import.meta.url),
      "utf8",
    );
    for (const name of SETTINGS) expect(guide, name).toContain(`\`${name}\``);
  });
});
