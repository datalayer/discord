import { MemoryWorkQueue } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, describe, expect, it } from "vitest";

import {
  componentOf,
  interactionsRoute,
  NOT_TAKEN,
  RESPONSE,
  UNKNOWN_COMPONENT,
  type InteractionJob,
} from "../../src/interactions.js";
import { EPHEMERAL } from "../../src/render.js";
import type { DiscordJob } from "../../src/resources.js";
import { MemoryStore } from "../../src/store.js";
import {
  ALICE,
  APPLICATION,
  CHANNEL,
  FakeHosts,
  GUILD,
  id,
  installation,
  quietLogger,
  serve,
  signingKey,
  testCipher,
} from "../support/discord.js";
import { harness } from "../support/worker.js";

/**
 * The interactions endpoint on a real socket (DC-102):
 * signature and window on the raw body, PING, normalize, claim and enqueue
 * in one transaction, the deferral's ephemeral state, and an explicit
 * refusal when nothing could be persisted.
 */

const key = signingKey();
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

class RecordingQueue extends MemoryWorkQueue<DiscordJob> {
  readonly jobs: DiscordJob[] = [];
  failing = false;
  override async enqueue(item: DiscordJob, idempotencyKey?: string) {
    if (this.failing) throw new Error("the database is down");
    const fresh = await super.enqueue(item, idempotencyKey);
    if (fresh) this.jobs.push(item);
    return fresh;
  }
}

function askCommand(overrides: Record<string, unknown> = {}) {
  return {
    app_permissions: "309237763136",
    application_id: APPLICATION,
    channel: { id: CHANNEL, type: 0 },
    data: {
      name: "ask",
      options: [{ name: "question", type: 3, value: "What changed?" }],
      type: 1,
    },
    guild_id: GUILD,
    id: id(900),
    member: { user: { id: ALICE, username: "alice" } },
    token: "interaction-token-for-tests",
    type: 2,
    version: 1,
    ...overrides,
  };
}

describe("POST /discord/interactions (DC-102)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function endpoint(
    now = NOW,
    shared: Partial<{
      store: MemoryStore;
      cipher: ReturnType<typeof testCipher>;
      hosts: FakeHosts["client"];
    }> = {},
  ) {
    const queue = new RecordingQueue();
    const store = shared.store ?? new MemoryStore();
    const lines: string[] = [];
    const served = await serve({
      "POST /discord/interactions": interactionsRoute({
        applicationId: APPLICATION,
        cipher: shared.cipher ?? testCipher(),
        hosts: shared.hosts ?? new FakeHosts().client,
        logger: quietLogger(lines),
        now: () => now,
        publicKey: key.publicKey,
        queue,
        store,
      }),
    });
    close = served.close;
    const post = (
      body: string,
      headers: Record<string, string> = {
        "x-signature-ed25519": key.sign(String(Math.floor(now / 1000)), body),
        "x-signature-timestamp": String(Math.floor(now / 1000)),
      },
    ) =>
      fetch(`${served.url}/discord/interactions`, {
        body,
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      });
    return { lines, post, queue, store };
  }

  it("answers PING with PONG and enqueues nothing", async () => {
    const { post, queue } = await endpoint();
    const response = await post(
      JSON.stringify({ application_id: APPLICATION, id: id(1), type: 1 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: RESPONSE.pong });
    expect(queue.jobs).toHaveLength(0);
  });

  it("refuses a forged signature, a changed body and a missing signature with 401", async () => {
    const { post, queue } = await endpoint();
    const body = JSON.stringify(askCommand());
    const at = String(Math.floor(NOW / 1000));
    const forged = signingKey().sign(at, body);
    expect(
      (
        await post(body, {
          "x-signature-ed25519": forged,
          "x-signature-timestamp": at,
        })
      ).status,
    ).toBe(401);
    const signed = key.sign(at, body);
    const changed = body.replace("What changed?", "Delete everything");
    expect(
      (
        await post(changed, {
          "x-signature-ed25519": signed,
          "x-signature-timestamp": at,
        })
      ).status,
    ).toBe(401);
    expect((await post(body, {})).status).toBe(401);
    // Discord's own probes: a PING with a bad signature is never answered 2xx.
    const ping = JSON.stringify({
      application_id: APPLICATION,
      id: id(1),
      type: 1,
    });
    expect(
      (
        await post(ping, {
          "x-signature-ed25519": "0".repeat(128),
          "x-signature-timestamp": at,
        })
      ).status,
    ).toBe(401);
    expect(queue.jobs).toHaveLength(0);
  });

  it("refuses a timestamp more than five minutes away, either way, though signed", async () => {
    const { post } = await endpoint();
    const body = JSON.stringify(askCommand());
    for (const skew of [-301, 301]) {
      const at = String(Math.floor(NOW / 1000) + skew);
      const response = await post(body, {
        "x-signature-ed25519": key.sign(at, body),
        "x-signature-timestamp": at,
      });
      expect(response.status).toBe(401);
    }
  });

  it("defers a linked person's /ask publicly, claims and enqueues it once, the token encrypted", async () => {
    const { post, queue, store } = await endpoint();
    await store.setLinked(APPLICATION, GUILD, ALICE, true);
    const body = JSON.stringify(askCommand());
    const first = await post(body);
    expect(await first.json()).toEqual({
      data: {},
      type: RESPONSE.deferredMessage,
    });
    // The same interaction again (a replay within the window): the same
    // answer, and nothing more enqueued.
    const again = await post(body);
    expect(await again.json()).toEqual({
      data: {},
      type: RESPONSE.deferredMessage,
    });
    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0] as InteractionJob;
    expect(job).toMatchObject({
      command: { name: "ask", options: { question: "What changed?" } },
      ephemeral: false,
      key: {
        applicationId: APPLICATION,
        channelId: CHANNEL,
        guildId: GUILD,
        thread: "",
      },
      threadFromOriginal: true,
      userId: ALICE,
    });
    expect(JSON.stringify(job)).not.toContain("interaction-token-for-tests");
  });

  it("defers privately an unlinked person, a private /ask, and every /datalayer command", async () => {
    const { post, store } = await endpoint();
    const unlinked = await post(JSON.stringify(askCommand({ id: id(901) })));
    expect(await unlinked.json()).toEqual({
      data: { flags: EPHEMERAL },
      type: RESPONSE.deferredMessage,
    });
    await store.setLinked(APPLICATION, GUILD, ALICE, true);
    const asked = askCommand({ id: id(902) });
    asked.data.options.push({ name: "private", type: 5, value: true } as never);
    expect(await (await post(JSON.stringify(asked))).json()).toEqual({
      data: { flags: EPHEMERAL },
      type: RESPONSE.deferredMessage,
    });
    const status = askCommand({
      data: {
        name: "datalayer",
        options: [{ name: "status", type: 1 }],
        type: 1,
      },
      id: id(903),
    });
    expect(await (await post(JSON.stringify(status))).json()).toEqual({
      data: { flags: EPHEMERAL },
      type: RESPONSE.deferredMessage,
    });
  });

  it("answers in public, with its thread, the first /ask after a link confirmed on the web: a pending code makes the ingress ask Datalayer", async () => {
    const store = new MemoryStore();
    const cipher = testCipher();
    const h = harness(store, undefined, cipher);
    await store.saveInstallation(installation(cipher));
    // /datalayer link: not linked at Datalayer, a code issued, the row
    // written as not linked.
    await h.worker.handle(
      h.job({
        command: { name: "datalayer", options: {}, subcommand: "link" },
        ephemeral: true,
        n: 800,
      }),
    );
    expect(await store.link(APPLICATION, GUILD, ALICE)).toEqual({
      linked: false,
      pendingUntil: NOW + 600_000,
    });
    // Confirmed on datalayer.ai: ai-agents has the link, the row does not.
    h.hosts.links.set(ALICE, "principal-alice");
    const { post, queue } = await endpoint(NOW + 11_000, {
      cipher,
      hosts: h.hosts.client,
      store,
    });
    const asked = await post(JSON.stringify(askCommand()));
    expect(await asked.json()).toEqual({
      data: {},
      type: RESPONSE.deferredMessage,
    });
    expect(await store.link(APPLICATION, GUILD, ALICE)).toEqual({
      linked: true,
    });
    const job = queue.jobs[0] as InteractionJob;
    expect(job.ephemeral).toBe(false);
    const before = h.port.bodies("editOriginal").length;
    await h.worker.handle(job);
    expect(h.port.count("startThread")).toBe(1);
    const answer = h.port.bodies("editOriginal").slice(before);
    expect(answer.length).toBeGreaterThan(0);
    expect(answer.every((body) => body.flags !== EPHEMERAL)).toBe(true);
  });

  it("keeps a pending code's /ask private until Datalayer says linked, settles an expired one, and answers privately when Datalayer cannot say", async () => {
    const hosts = new FakeHosts();
    const cipher = testCipher();
    const store = new MemoryStore();
    await store.saveInstallation(installation(cipher));
    await store.setLinked(APPLICATION, GUILD, ALICE, false);
    await store.setLinkPending(APPLICATION, GUILD, ALICE, NOW + 600_000);
    const ask = async (at: number, n: number, client = hosts.client) => {
      const { lines, post } = await endpoint(at, {
        cipher,
        hosts: client,
        store,
      });
      const answered = await post(JSON.stringify(askCommand({ id: id(n) })));
      const body = (await answered.json()) as { data: unknown };
      await close?.();
      close = undefined;
      return { body, lines };
    };
    // Not confirmed yet: private, still pending (a /datalayer status in
    // between, which writes not linked, keeps it).
    expect((await ask(NOW, 910)).body.data).toEqual({ flags: EPHEMERAL });
    await store.setLinked(APPLICATION, GUILD, ALICE, false);
    expect((await store.link(APPLICATION, GUILD, ALICE))?.pendingUntil).toBe(
      NOW + 600_000,
    );
    // Datalayer down: private, said in the log, still pending.
    const failing = await ask(NOW + 1_000, 911, {
      ...hosts.client,
      linkState: async () => {
        throw new Error("Datalayer is down");
      },
    });
    expect(failing.body.data).toEqual({ flags: EPHEMERAL });
    expect(failing.lines.join("\n")).toContain("interaction.link_unchecked");
    expect((await store.link(APPLICATION, GUILD, ALICE))?.pendingUntil).toBe(
      NOW + 600_000,
    );
    // Expired unconfirmed: private, and settled.
    expect((await ask(NOW + 600_000, 912)).body.data).toEqual({
      flags: EPHEMERAL,
    });
    expect(await store.link(APPLICATION, GUILD, ALICE)).toEqual({
      linked: false,
    });
  });

  it("keys a thread by itself and its parent", async () => {
    const { post, queue, store } = await endpoint();
    await store.setLinked(APPLICATION, GUILD, ALICE, true);
    await post(
      JSON.stringify(
        askCommand({ channel: { id: id(700), parent_id: CHANNEL, type: 11 } }),
      ),
    );
    expect((queue.jobs[0] as InteractionJob).key).toEqual({
      applicationId: APPLICATION,
      channelId: id(700),
      guildId: GUILD,
      parentId: CHANNEL,
      thread: id(700),
    });
  });

  it("answers an explicit ephemeral refusal when the job cannot be persisted, never silence", async () => {
    const { post, queue, lines } = await endpoint();
    queue.failing = true;
    const response = await post(JSON.stringify(askCommand()));
    expect(await response.json()).toEqual({
      data: {
        allowed_mentions: { parse: [] },
        content: NOT_TAKEN,
        flags: EPHEMERAL,
      },
      type: RESPONSE.message,
    });
    expect(lines.join("\n")).toContain("interaction.not_persisted");
    expect(lines.join("\n")).not.toContain("interaction-token-for-tests");
  });

  it("answers Approve with the confirmation modal at once, Stop with a deferred update, Show and Open privately, and an unknown button with a refusal", async () => {
    const { post, queue } = await endpoint();
    const press = (customId: string, n: number) =>
      post(
        JSON.stringify(
          askCommand({
            data: { component_type: 2, custom_id: customId },
            id: id(n),
            type: 3,
          }),
        ),
      );
    const approve = await (await press("dc:approve:abcdefghijkl", 910)).json();
    expect(approve).toMatchObject({
      data: { custom_id: "dc:confirm-approve:abcdefghijkl" },
      type: RESPONSE.modal,
    });
    expect(await (await press("dc:stop:abcdefghijkl", 911)).json()).toEqual({
      type: RESPONSE.deferredUpdate,
    });
    expect(await (await press("dc:show:abcdefghijkl", 912)).json()).toEqual({
      data: { flags: EPHEMERAL },
      type: RESPONSE.deferredMessage,
    });
    // Open in Datalayer: the presser's own link, made by the worker, private.
    expect(await (await press("dc:open:abcdefghijkl", 914)).json()).toEqual({
      data: { flags: EPHEMERAL },
      type: RESPONSE.deferredMessage,
    });
    const unknown = (await (
      await press("dc:delete-all:abcdefghijkl", 913)
    ).json()) as { data: { content: string } };
    expect(unknown.data.content).toBe(UNKNOWN_COMPONENT);
    expect(
      queue.jobs.map((job) => (job as InteractionJob).component?.kind),
    ).toEqual(["stop", "show", "open"]);
    expect((queue.jobs.at(-1) as InteractionJob | undefined)?.ephemeral).toBe(
      true,
    );
  });

  it("autocompletes from the cached allowances, at most 25, with no network call", async () => {
    const { post, store, queue } = await endpoint();
    await store.setAllowances(
      APPLICATION,
      GUILD,
      Array.from({ length: 30 }, (_, n) => ({
        applicationId: `deployment-${n}`,
        channelPolicy: "channels" as const,
        enabled: true,
        name: `Analyst ${n}`,
      })),
    );
    const answer = (await (
      await post(
        JSON.stringify(
          askCommand({
            data: {
              name: "ask",
              options: [
                {
                  focused: true,
                  name: "application",
                  type: 3,
                  value: "analyst",
                },
              ],
              type: 1,
            },
            type: 4,
          }),
        ),
      )
    ).json()) as {
      type: number;
      data: { choices: unknown[] };
    };
    expect(answer.type).toBe(RESPONSE.autocomplete);
    expect(answer.data.choices).toHaveLength(25);
    expect(queue.jobs).toHaveLength(0);
  });

  it("names its components dc:<kind>:<render id> and nothing else", () => {
    expect(componentOf("dc:stop:abcdefghijkl")).toEqual({
      kind: "stop",
      renderId: "abcdefghijkl",
    });
    for (const forged of [
      "dc:stop",
      "dc:stop:short",
      "xx:stop:abcdefghijkl",
      "dc:stop:abcdefghijkl:extra",
      "dc:root:abcdefghijkl",
    ])
      expect(componentOf(forged)).toBeUndefined();
  });
});
