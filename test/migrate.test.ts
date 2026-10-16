import { execFileSync } from "node:child_process";

import { hostTables } from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migrations on a throwaway PostgreSQL (`DATALAYER_DISCORD_TEST_DATABASE_URL`,
 * never a cluster's): the shared host tables under `discord_`, then
 * `migrations/`, applied twice to the same end (DC-008).
 */
const DATABASE_URL = process.env.DATALAYER_DISCORD_TEST_DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))("migrate on PostgreSQL", () => {
  let database: pg.Pool;
  beforeAll(async () => {
    database = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await database.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  });
  afterAll(async () => {
    await database?.end();
  });

  const migrate = () =>
    execFileSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL },
    });

  it("makes the shared tables and the Discord ones, and is idempotent", async () => {
    expect(migrate()).toContain("Applied the shared host tables");
    const tables = async () =>
      (
        await database.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        )
      ).rows.map((row) => row.table_name);
    const first = await tables();
    expect(first).toEqual(
      [
        ...hostTables("discord"),
        "discord_allowance",
        "discord_component",
        "discord_installation",
        "discord_oauth_state",
        "discord_thread_binding",
        "discord_turn",
        "discord_user_link",
      ].sort(),
    );
    migrate();
    expect(await tables()).toEqual(first);
  }, 60_000);
});
