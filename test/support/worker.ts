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
  FakeAsPerson,
  FakeClock,
  FakeHosts,
  FakePort,
  GUILD,
  id,
  installation,
  quietLogger,
  testCipher,
} from "./discord.js";

/** A worker over fakes, and a builder of its `/ask` jobs. */

const TOKEN = "interaction-token-for-tests";
/** Everything the bot asks for. */
const ALL = "309237763136";

export type Harness = Readonly<{
  clock: FakeClock;
  port: FakePort;
  hosts: FakeHosts;
  agent: FakeAgent;
  asPerson: FakeAsPerson;
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
  const asPerson = new FakeAsPerson();
  const worker = new Worker({
    agent,
    applicationId: APPLICATION,
    asPerson,
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
    asPerson,
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

/**
 * A press of a component in a thread, as the ingress persisted it: deferred
 * privately (*Show the request*, *Open in Datalayer*), or, with `modal`, a
 * confirmation's submit deferred as an update of the card.
 */
export function press(
  h: Harness,
  kind: "show" | "approve" | "reject" | "open",
  renderId: string,
  userId: string,
  n: number,
): InteractionJob {
  const { command, ...job } = h.job({ n, userId });
  void command;
  return {
    ...job,
    component: { kind, renderId },
    ephemeral: true,
    key: {
      ...job.key,
      channelId: id(500),
      parentId: CHANNEL,
      thread: id(500),
    },
    threadFromOriginal: false,
    type: 3,
  };
}

/** A confirmation modal's submit (Approve or Reject), deferred as an update. */
export function submit(
  h: Harness,
  approve: boolean,
  renderId: string,
  userId: string,
  n: number,
  note = "",
): InteractionJob {
  const { command, ...job } = h.job({ n, userId });
  void command;
  return {
    ...job,
    ephemeral: false,
    fields: { note },
    key: {
      ...job.key,
      channelId: id(500),
      parentId: CHANNEL,
      thread: id(500),
    },
    modal: `dc:confirm-${approve ? "approve" : "reject"}:${renderId}`,
    threadFromOriginal: false,
    type: 5,
  };
}
