import {
  DEFAULT_QUOTAS,
  MemoryQuotaStore,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { InteractionJob } from "../../src/interactions.js";
import { MemoryStore, type DiscordStore } from "../../src/store.js";
import { Worker } from "../../src/worker.js";
import {
  ALICE,
  APPLICATION,
  CHANNEL,
  FakeAgent,
  FakeClock,
  FakeHosts,
  FakePort,
  GUILD,
  id,
  installation,
  quietLogger,
  testCipher,
} from "./discord.js";

/** A worker over fakes, and a builder of its `/ask` jobs (plans/DISCORD.md §12.1). */

const TOKEN = "interaction-token-for-tests";
/** Everything the bot asks for (§6.2). */
const ALL = "309237763136";

export type Harness = Readonly<{
  clock: FakeClock;
  port: FakePort;
  hosts: FakeHosts;
  agent: FakeAgent;
  store: DiscordStore;
  cipher: SecretCipher;
  quotas: MemoryQuotaStore;
  worker: Worker;
  job(
    overrides?: Partial<InteractionJob> & { question?: string; n?: number },
  ): InteractionJob;
}>;

export function harness(
  store: DiscordStore = new MemoryStore(),
  instance?: string,
  cipher: SecretCipher = testCipher(),
): Harness {
  const clock = new FakeClock();
  const port = new FakePort();
  const hosts = new FakeHosts();
  const agent = new FakeAgent(clock);
  const quotas = new MemoryQuotaStore();
  const worker = new Worker({
    agent,
    applicationId: APPLICATION,
    cipher,
    clock,
    hosts: hosts.client,
    ...(instance ? { instance } : {}),
    limits: DEFAULT_QUOTAS,
    logger: quietLogger(),
    openLink: (request, kind, target) => hosts.openLink(request, kind, target),
    port,
    quotas,
    store,
    webUrl: "https://datalayer.ai",
  });
  return {
    agent,
    cipher,
    clock,
    hosts,
    job: ({ question = "What changed?", n = 900, ...overrides } = {}) => {
      const interaction = overrides.id ?? id(n);
      return {
        appPermissions: ALL,
        command: { name: "ask", options: { question } },
        ephemeral: false,
        id: interaction,
        key: {
          applicationId: APPLICATION,
          channelId: CHANNEL,
          guildId: GUILD,
          thread: "",
        },
        kind: "interaction",
        receivedAt: clock.now(),
        threadFromOriginal: true,
        token: cipher.encrypt(TOKEN, interaction),
        type: 2,
        userId: ALICE,
        userName: "alice",
        ...overrides,
      };
    },
    port,
    quotas,
    store,
    worker,
  };
}

export async function connected(h: Harness): Promise<void> {
  await h.store.saveInstallation(installation(h.cipher));
  h.hosts.links.set(ALICE, "principal-alice");
}
