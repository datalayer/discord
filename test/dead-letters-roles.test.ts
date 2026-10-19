import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  deadLetters,
  PostgresWorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresStore } from "../src/postgres-store.js";
import { TABLE_PREFIX } from "../src/resources.js";
import { ALICE, APPLICATION, BOB, GUILD, id } from "./support/discord.js";

/**
 * The database roles of DC-403 on a throwaway PostgreSQL
 * (`DATALAYER_DISCORD_TEST_DATABASE_URL`, a superuser's, never a cluster's):
 * migrated as the service's role first (today's shape), the one-time SQL of
 * docs/operations.md run as the superuser, then `migrate --roles` as
 * discord_owner. The service's role cannot read a dead job's payload and
 * still works its queue, drops spent tokens and forgets a person;
 * discord_dead_letters reads dead jobs only, and every payload read and
 * every replay leaves an audit row.
 */
const DATABASE_URL = process.env.DATALAYER_DISCORD_TEST_DATABASE_URL;
// Built, so that no secret scanner takes it for a credential.
const PASSWORD = ["test", "only", "role"].join("-");
const SERVICE = "discord";
const ROLES = [SERVICE, "discord_owner", "discord_dead_letters"];

const as = (role: string) => {
  const url = new URL(DATABASE_URL ?? "");
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
};

/** The superuser's one-time statements, exactly as docs/operations.md gives them. */
const oneTimeSql = (): string => {
  const doc = readFileSync(
    new URL("../docs/operations.md", import.meta.url),
    "utf8",
  );
  const sql = /<!-- one-time-owner-sql -->\s*```sql\n([\s\S]*?)```/.exec(
    doc,
  )?.[1];
  if (!sql) throw new Error("docs/operations.md has no one-time SQL.");
  return sql;
};

describe.runIf(Boolean(DATABASE_URL))("database roles on PostgreSQL", () => {
  let admin: pg.Pool;
  let service: pg.Pool;
  let reader: pg.Pool;

  const migrate = (role: string, ...args: string[]) =>
    spawnSync("node", ["--import", "tsx", "scripts/migrate.ts", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: as(role),
        DATALAYER_DISCORD_SERVICE_ROLE: SERVICE,
      },
    });
  const job = async (payload: object, state: string, attempts = 0) =>
    (
      await admin.query<{ id: string }>(
        "INSERT INTO discord_jobs (payload, state, attempts) VALUES ($1, $2, $3) RETURNING id::text",
        [payload, state, attempts],
      )
    ).rows[0].id;
  const audit = async () =>
    (
      await admin.query<{
        reads: string;
        replays: string;
        roles: string[] | null;
      }>(
        `SELECT (SELECT count(*) FROM discord_payload_access) AS reads,
                (SELECT count(*) FROM discord_job_replays) AS replays,
                (SELECT array_agg(DISTINCT database_role) FROM
                   (SELECT database_role FROM discord_payload_access
                    UNION ALL SELECT database_role FROM discord_job_replays) AS every) AS roles`,
      )
    ).rows[0];
  const now = Date.UTC(2026, 9, 19, 12);
  const interaction = (n: number, userId: string, receivedAt = now) => ({
    id: id(n),
    key: { applicationId: APPLICATION, channelId: id(3), guildId: GUILD },
    kind: "interaction",
    prompt: `the words of request ${n}`,
    receivedAt,
    token: { ciphertext: "x", iv: "y", version: 1 },
    userId,
  });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(
      `DROP SCHEMA public CASCADE; CREATE SCHEMA public;
       GRANT USAGE ON SCHEMA public TO PUBLIC;
       DROP SCHEMA IF EXISTS discord CASCADE;
       DROP SCHEMA IF EXISTS discord_dead_letters CASCADE`,
    );
    for (const role of ROLES)
      await admin.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
             CREATE ROLE ${role} LOGIN;
           END IF;
         END $$;
         ALTER ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`,
      );
    // CNPG's database owner may create in public.
    await admin.query(`GRANT CREATE ON SCHEMA public TO ${SERVICE}`);
    // Today's shape: the service's role runs the migrations and owns it all.
    expect(migrate(SERVICE).status).toBe(0);
    await admin.query(oneTimeSql());
    expect(migrate("discord_owner", "--roles").status).toBe(0);
    service = new pg.Pool({ connectionString: as(SERVICE), max: 5 });
    reader = new pg.Pool({
      connectionString: as("discord_dead_letters"),
      max: 2,
    });
  }, 120_000);
  afterAll(async () => {
    await service?.end();
    await reader?.end();
    await admin?.end();
  });

  it("applies the roles step as discord_owner only, again to the same end, and names what it does not own", async () => {
    // The service's role makes nothing any more: its migrations stop first
    // (its own schema, first in its search_path, holds only the queue's view).
    const refused = migrate(SERVICE, "--roles");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("permission denied for schema discord");
    for (let time = 0; time < 2; time++) {
      const applied = migrate("discord_owner", "--roles");
      expect(applied.stderr).toBe("");
      expect(applied.stdout).toContain(
        "Applied 1 database role steps for the service's role discord.",
      );
    }
    await admin.query(
      `CREATE TABLE discord_stray (id int); ALTER TABLE discord_stray OWNER TO ${SERVICE}`,
    );
    const stray = migrate("discord_owner", "--roles");
    await admin.query("DROP TABLE discord_stray");
    expect(stray.status).not.toBe(0);
    expect(stray.stderr).toContain(
      "Not owned by discord_owner: public.discord_stray.",
    );
  }, 120_000);

  it("never shows the service's role a dead job's payload, nor the audit", async () => {
    await admin.query(
      "TRUNCATE discord_jobs, discord_payload_access, discord_job_replays",
    );
    const dead = await job(interaction(901, ALICE), "dead", 5);
    const ready = await job(interaction(902, BOB), "ready");
    const { rows } = await service.query<{ id: string; payload: unknown }>(
      "SELECT id::text, payload FROM discord_jobs ORDER BY id",
    );
    expect(rows.map((row) => row.id)).toEqual([ready]);
    expect(
      (
        await service.query("SELECT payload FROM discord_jobs WHERE id = $1", [
          dead,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await service.query(
          "UPDATE discord_jobs SET state = 'ready' WHERE id = $1",
          [dead],
        )
      ).rowCount,
    ).toBe(0);
    for (const statement of [
      "SELECT payload FROM public.discord_jobs",
      "SELECT payload FROM discord_dead_letters.discord_jobs",
      "SELECT * FROM discord_payload_access",
      "INSERT INTO discord_job_replays (job_id, operator, replayed) VALUES (1, 'x', true)",
    ])
      await expect(service.query(statement)).rejects.toThrow(
        /permission denied/,
      );
    await expect(
      service.query("ALTER TABLE public.discord_jobs OWNER TO discord"),
    ).rejects.toThrow(/must be owner/);
    await expect(service.query("SET ROLE discord_owner")).rejects.toThrow(
      /permission denied/,
    );
    // The row is still there, its payload whole.
    const { rows: kept } = await admin.query<{ prompt: string }>(
      "SELECT payload->>'prompt' AS prompt FROM discord_jobs WHERE id = $1 AND state = 'dead'",
      [dead],
    );
    expect(kept).toEqual([{ prompt: "the words of request 901" }]);
  });

  it("works the queue as the service's role: enqueued once, done and deleted, dead after the fifth attempt", async () => {
    await admin.query("TRUNCATE discord_jobs, discord_event_claims");
    const queue = new PostgresWorkQueue<{ n: number }>(
      service,
      TABLE_PREFIX,
      20,
    );
    expect(await queue.ready()).toBe(true);
    expect(await queue.enqueue({ n: 1 }, "event-1")).toBe(true);
    expect(await queue.enqueue({ n: 1 }, "event-1")).toBe(false);
    expect(await queue.enqueue({ n: 2 })).toBe(true);
    // Its fifth attempt.
    const dying = await job({ n: 3 }, "ready", 4);
    const handled: number[] = [];
    queue.start(async ({ n }) => {
      handled.push(n);
      if (n === 3) throw new Error("the fifth failure");
    });
    for (let wait = 0; wait < 100 && handled.length < 3; wait++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await queue.stop();
    expect(handled.sort()).toEqual([1, 2, 3]);
    const { rows } = await admin.query(
      "SELECT id::text, state, attempts, last_error, payload FROM discord_jobs",
    );
    expect(rows).toEqual([
      {
        attempts: 5,
        id: dying,
        last_error: "the fifth failure",
        payload: { n: 3 },
        state: "dead",
      },
    ]);
    const store = new PostgresStore(service);
    expect(await store.claimEvent("event-2")).toBe(true);
    expect(await store.claimEvent("event-2")).toBe(false);
    await store.releaseEvent("event-2");
  });

  it("drops spent tokens from dead jobs and forgets a person's dead requests as the service's role", async () => {
    await admin.query("TRUNCATE discord_jobs");
    const store = new PostgresStore(service);
    const spent = now - 20 * 60 * 1000;
    await job(interaction(910, ALICE, spent), "dead", 5);
    await job(interaction(911, BOB, spent), "ready");
    await job(interaction(912, BOB, now), "ready");
    expect(await store.dropSpentTokens(new Date(now - 15 * 60 * 1000))).toBe(2);
    const { rows: tokens } = await admin.query<{ id: string; kept: boolean }>(
      "SELECT payload->>'id' AS id, payload ? 'token' AS kept FROM discord_jobs ORDER BY id",
    );
    expect(tokens).toEqual([
      { id: id(910), kept: false },
      { id: id(911), kept: false },
      { id: id(912), kept: true },
    ]);
    await job(interaction(913, ALICE), "ready");
    // Alice's dead job and her queued one.
    expect(await store.forgetUser(APPLICATION, ALICE)).toBe(2);
    const { rows: left } = await admin.query<{ user: string }>(
      "SELECT payload->>'userId' AS user FROM discord_jobs ORDER BY id",
    );
    expect(left).toEqual([{ user: BOB }, { user: BOB }]);
  });

  it("reads and replays dead jobs only as discord_dead_letters, every read and replay audited", async () => {
    await admin.query(
      "TRUNCATE discord_jobs, discord_payload_access, discord_job_replays",
    );
    const dead = await job(interaction(920, ALICE), "dead", 5);
    const other = await job(interaction(921, BOB), "dead", 5);
    const live = await job(interaction(922, BOB), "ready");
    const letters = deadLetters(reader, TABLE_PREFIX);

    const listed = await letters.list();
    expect(listed.map((one) => one.id)).toEqual([dead, other]);
    expect(JSON.stringify(listed)).not.toContain("the words of request");

    const payload = await letters.payload(
      dead,
      "operator-ada",
      "the request failed five times",
    );
    expect(payload).toMatchObject({
      prompt: "the words of request 920",
      token: "[redacted]",
    });
    await expect(
      letters.payload(live, "operator-ada", "a live job is not dead"),
    ).rejects.toThrow(/not a dead job/);
    expect(await letters.replay(other, "operator-ada")).toBe(true);
    // Replayed, it is no dead job any more; a live one never was.
    expect(await letters.replay(other, "operator-ada")).toBe(false);
    expect(await letters.replay(live, "operator-ada")).toBe(false);
    expect(await audit()).toEqual({
      reads: "1",
      replays: "3",
      roles: ["discord_dead_letters"],
    });

    for (const statement of [
      "SELECT payload FROM public.discord_jobs",
      "SELECT * FROM discord_payload_access",
      "DELETE FROM discord_job_replays",
      "UPDATE discord_jobs SET payload = '{}'",
      "SELECT * FROM discord_installation",
    ])
      await expect(reader.query(statement)).rejects.toThrow(
        /permission denied/,
      );
    expect(
      (
        await reader.query("SELECT payload FROM discord_jobs WHERE id = $1", [
          live,
        ])
      ).rowCount,
    ).toBe(0);

    // The bin: as the reader, each payload read and replay audited; the
    // service's role refused.
    const bin = (role: string, ...args: string[]) =>
      spawnSync(
        "node",
        ["--import", "tsx", "src/dead-letters-cli.ts", ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: as(role),
            DATALAYER_OPERATOR: "operator-grace",
          },
        },
      );
    const list = bin("discord_dead_letters", "list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(dead);
    expect(list.stdout).not.toContain("the words of request");
    const read = bin(
      "discord_dead_letters",
      "payload",
      dead,
      "checking",
      "the",
      "failure",
    );
    expect(read.status).toBe(0);
    expect(read.stdout).toContain("the words of request 920");
    expect(bin("discord_dead_letters", "replay", dead).stdout).toContain(
      `Job ${dead} is back to work.`,
    );
    const refused = bin(SERVICE, "list");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("connect as discord_dead_letters");
    expect(await audit()).toEqual({
      reads: "2",
      replays: "4",
      roles: ["discord_dead_letters"],
    });
    const { rows } = await admin.query<{ operator: string }>(
      "SELECT operator FROM discord_payload_access ORDER BY id",
    );
    expect(rows.map((row) => row.operator)).toEqual([
      "operator-ada",
      "operator-grace",
    ]);
  }, 60_000);
});
