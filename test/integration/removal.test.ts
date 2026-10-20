import { describe, expect, it } from "vitest";

import { DiscordError } from "../../src/discord-port.js";
import {
  purgeRemoved,
  reconcile,
  removeInstallation,
} from "../../src/removal.js";
import { MemoryStore } from "../../src/store.js";
import { UNKNOWN_GUILD, Worker } from "../../src/worker.js";
import {
  APPLICATION,
  FakeHosts,
  FakePort,
  GUILD,
  id,
  installation,
  quietLogger,
  testCipher,
} from "../support/discord.js";
import { connected, harness } from "../support/worker.js";

/**
 * Removal (DC-107): no event says a bot left a server,
 * so Unknown Guild on use and the paginated daily reconciliation find it;
 * each marks the installation removed once and revokes it at Datalayer; late
 * work does nothing; the rows go 24 hours later.
 */

function dependencies(now = Date.UTC(2026, 9, 16, 12)) {
  const store = new MemoryStore();
  const hosts = new FakeHosts();
  const cipher = testCipher();
  return {
    applicationId: APPLICATION,
    cipher,
    hosts,
    logger: quietLogger(),
    now: () => now,
    port: new FakePort(),
    store,
  };
}

describe("removal (DC-107)", () => {
  it("reconciles past 200 guilds a page: only the servers Discord no longer lists are removed, and revoked once", async () => {
    const removal = dependencies();
    const kept = id(150);
    const gone = id(9_999);
    const late = id(260);
    for (const guildId of [kept, gone, late])
      await removal.store.saveInstallation(
        installation(removal.cipher, { guildId }),
      );
    removal.port.guildPages = [
      Array.from({ length: 200 }, (_, n) => ({ id: id(n + 1) })),
      Array.from({ length: 80 }, (_, n) => ({ id: id(n + 201) })),
    ];
    const removed = await reconcile({
      ...removal,
      hosts: removal.hosts.client,
    });
    expect(removed).toBe(1);
    expect(
      removal.port.calls
        .filter((call) => call.method === "botGuilds")
        .map((call) => call.args[0]),
    ).toEqual([undefined, id(200)]);
    expect((await removal.store.installation(APPLICATION, gone))?.state).toBe(
      "removed",
    );
    expect((await removal.store.installation(APPLICATION, kept))?.state).toBe(
      "active",
    );
    expect((await removal.store.installation(APPLICATION, late))?.state).toBe(
      "active",
    );
    expect(removal.hosts.uninstalledKeys).toEqual(["dlhk_test_key"]);
    // Again: nothing more, nothing revoked twice.
    removal.port.guildPages = [[{ id: kept }, { id: late }]];
    expect(await reconcile({ ...removal, hosts: removal.hosts.client })).toBe(
      0,
    );
    expect(removal.hosts.uninstalledKeys).toHaveLength(1);
  });

  it("purges a removed server's rows 24 hours after its removal, not before", async () => {
    let now = Date.UTC(2026, 9, 16, 12);
    const removal = { ...dependencies(), now: () => now };
    await removal.store.saveInstallation(installation(removal.cipher));
    await removal.store.setLinked(APPLICATION, GUILD, id(11), true);
    await removeInstallation(
      { ...removal, hosts: removal.hosts.client },
      GUILD,
      "reconciliation",
    );
    now += 23 * 60 * 60 * 1000;
    expect(
      await purgeRemoved({ ...removal, hosts: removal.hosts.client }),
    ).toBe(0);
    now += 60 * 60 * 1000;
    expect(
      await purgeRemoved({ ...removal, hosts: removal.hosts.client }),
    ).toBe(1);
    expect(
      await removal.store.installation(APPLICATION, GUILD),
    ).toBeUndefined();
    expect(
      await removal.store.link(APPLICATION, GUILD, id(11)),
    ).toBeUndefined();
  });

  it("removes a server Discord calls unknown on use, and then a queued /ask and a button press do nothing", async () => {
    const h = harness();
    await connected(h);
    const removals: string[] = [];
    // The worker's removal hook, wired as index.ts wires it.
    const worker = new Worker({
      ...h.worker.deps,
      removed: async (guildId) => {
        removals.push(guildId);
        await removeInstallation(
          {
            applicationId: APPLICATION,
            cipher: h.cipher,
            hosts: h.hosts.client,
            logger: quietLogger(),
            store: h.store,
          },
          guildId,
          "unknown-guild",
        );
      },
    });
    h.port.failures.set("original", [
      new DiscordError(404, UNKNOWN_GUILD, "webhook:original"),
    ]);
    await worker.handle(h.job());
    expect(removals).toEqual([GUILD]);
    expect((await h.store.installation(APPLICATION, GUILD))?.state).toBe(
      "removed",
    );

    const before = h.port.calls.length;
    await worker.handle(h.job({ id: id(920) }));
    await worker.handle(
      h.job({
        command: undefined,
        component: { kind: "stop", renderId: "abcdefghijkl" },
        id: id(921),
        type: 3,
      }),
    );
    expect(h.port.calls.length).toBe(before);
    expect(h.agent.started).toHaveLength(0);
  });
});
