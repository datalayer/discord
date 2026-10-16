import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { AddressInfo } from "node:net";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  HostRefusedError,
  Logger,
  presentationSchema,
  SecretCipher,
  type AgentClient,
  type ApprovalPresentation,
  type Clock,
  type HostSelf,
  type HostTurnRequest,
  type SemanticEvent,
  type SessionBinder,
  type TurnStream,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { AsPerson, Person } from "../../src/as-person.js";
import type {
  BotAuthorization,
  DiscordPort,
  MessageBody,
  SentMessage,
} from "../../src/discord-port.js";
import { DiscordError } from "../../src/discord-port.js";
import { discordShape, type DiscordTurn } from "../../src/domain.js";
import { createHttpServer, type Routes } from "../../src/server.js";
import type { Installation } from "../../src/store.js";

/**
 * Test doubles for Discord and Datalayer (plans/DISCORD.md §12.1: ordinary
 * tests need neither). Ids are built so no secret scanner takes them for
 * credentials; nothing here is one.
 */

/** A Discord-shaped snowflake for tests: 18 digits, from a small number. */
export const id = (n: number): string => `1${String(n).padStart(17, "0")}`;

export const APPLICATION = id(1);
export const GUILD = id(2);
export const CHANNEL = id(3);
export const ALICE = id(11);
export const BOB = id(12);

/** An Ed25519 key pair as Discord's: the public key in hex, a signer. */
export function signingKey(): {
  publicKey: string;
  sign(timestamp: string, body: string): string;
} {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string };
  const privateKey: KeyObject = pair.privateKey;
  return {
    publicKey: Buffer.from(jwk.x, "base64url").toString("hex"),
    sign: (timestamp, body) =>
      sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
  };
}

export const quietLogger = (lines: string[] = []) =>
  new Logger((line) => lines.push(line), undefined, "test");

export const testCipher = () =>
  new SecretCipher(randomBytes(32).toString("base64"), 1, "test key");

/** A clock tests move by hand; `sleep` moves it. */
export class FakeClock implements Clock {
  constructor(public at = Date.UTC(2026, 9, 16, 12, 0, 0)) {}
  now(): number {
    return this.at;
  }
  async sleep(milliseconds: number): Promise<void> {
    this.at += milliseconds;
  }
  advance(milliseconds: number): void {
    this.at += milliseconds;
  }
}

/** Serve routes on a real socket: what each request answered. */
export async function serve(routes: Routes): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createHttpServer({}, routes);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${port}`,
  };
}

export type PortCall = Readonly<{
  method: keyof DiscordPort;
  args: readonly unknown[];
}>;

/** Discord's REST port, recorded; failures injected by method. */
export class FakePort implements DiscordPort {
  readonly calls: PortCall[] = [];
  originalId = id(500);
  #next = 600;
  /** Throw once from a method: the error, by method name. */
  readonly failures = new Map<keyof DiscordPort, Error[]>();
  guildPages: Array<Array<{ id: string }>> = [];
  authorization: BotAuthorization = {
    guild: { id: GUILD, name: "Test" },
    scope: "bot applications.commands",
  };

  #record(method: keyof DiscordPort, args: unknown[]): void {
    this.calls.push({ args, method });
    const queued = this.failures.get(method);
    const failure = queued?.shift();
    if (failure) throw failure;
  }

  /** The bodies sent through one method, in order. */
  bodies(method: keyof DiscordPort): MessageBody[] {
    return this.calls
      .filter((call) => call.method === method)
      .map((call) => call.args[call.args.length - 1] as MessageBody);
  }

  count(method: keyof DiscordPort): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  async original(token: string): Promise<SentMessage> {
    this.#record("original", [token]);
    return { channelId: CHANNEL, id: this.originalId };
  }
  async editOriginal(token: string, body: MessageBody): Promise<SentMessage> {
    this.#record("editOriginal", [token, body]);
    return { channelId: CHANNEL, id: this.originalId };
  }
  async deleteOriginal(token: string): Promise<void> {
    this.#record("deleteOriginal", [token]);
  }
  async followUp(token: string, body: MessageBody): Promise<SentMessage> {
    this.#record("followUp", [token, body]);
    return { channelId: CHANNEL, id: id((this.#next += 1)) };
  }
  async createMessage(
    channelId: string,
    body: MessageBody,
  ): Promise<SentMessage> {
    this.#record("createMessage", [channelId, body]);
    return { channelId, id: id((this.#next += 1)) };
  }
  async editMessage(
    channelId: string,
    messageId: string,
    body: MessageBody,
  ): Promise<SentMessage> {
    this.#record("editMessage", [channelId, messageId, body]);
    return { channelId, id: messageId };
  }
  async startThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<{ id: string }> {
    this.#record("startThread", [channelId, messageId, name]);
    return { id: messageId };
  }
  async botGuilds(after?: string): Promise<Array<{ id: string }>> {
    this.#record("botGuilds", [after]);
    return this.guildPages.shift() ?? [];
  }
  async authorize(
    code: string,
    redirectUri: string,
  ): Promise<BotAuthorization> {
    this.#record("authorize", [code, redirectUri]);
    return this.authorization;
  }
}

export const tokenGone = () => new DiscordError(404, 10015, "webhook:original");

/** ai-agents' host routes, as the worker uses them. */
export class FakeHosts {
  links = new Map<string, string>();
  unlinked: string[] = [];
  /** The host key each unlink was made with: which installation it ended. */
  unlinkedKeys: string[] = [];
  bound: Array<{ code: string; externalId: string }> = [];
  spentCodes = new Set<string>();
  uninstalledKeys: string[] = [];
  self: HostSelf = {
    accountUid: "account-1",
    channels: [],
    defaultDeployment: "deployment-1",
    deployments: [
      { appName: "Analyst", kept: true, uid: "deployment-1" },
      { appName: "Writer", kept: true, uid: "deployment-2" },
    ],
    directOnly: [],
    paused: false,
  };

  async linkState(_hostKey: string, user: string) {
    const principalUid = this.links.get(user);
    return principalUid ? { linked: true, principalUid } : { linked: false };
  }
  async linkCode(_hostKey: string, user: string) {
    return { code: `dlhc_test_${user}`, expiresIn: 600 };
  }
  async unlink(hostKey: string, user: string) {
    const had = this.links.delete(user);
    this.unlinked.push(user);
    this.unlinkedKeys.push(hostKey);
    return had ? 1 : 0;
  }
  async bind(input: { code: string; externalId: string }) {
    if (this.spentCodes.has(input.code))
      throw new HostRefusedError(
        410,
        "The code was used or expired.",
        "Datalayer did not bind the installation",
      );
    this.spentCodes.add(input.code);
    this.bound.push(input);
    return {
      hostKey: `dlhk_test_${this.bound.length}`,
      hostUid: `host-${this.bound.length}`,
    };
  }
  async uninstalled(hostKey: string) {
    this.uninstalledKeys.push(hostKey);
  }
  /** The handoffs made, as whom and to what (*Open in Datalayer*). */
  handoffs: Array<{
    user: string;
    kind: "session" | "approval";
    target: string;
  }> = [];
  async openLink(
    request: HostTurnRequest<DiscordTurn>,
    kind: "session" | "approval",
    target: string,
  ): Promise<string> {
    if (!this.links.has(request.externalUserId))
      throw new HostRefusedError(
        403,
        "The person is not linked.",
        "Datalayer refused the host credential exchange",
      );
    this.handoffs.push({ kind, target, user: request.externalUserId });
    return `/hosts/open?code=dlho_test_${this.handoffs.length}`;
  }
  /** Who the installation's owner is linked as, in the host: only they administer it. */
  owner = id(11);
  changes: unknown[] = [];
  async admin(
    _hostKey: string,
    user: string,
    change: {
      paused?: boolean;
      channel?: { id: string; state: "allow" | "deny" };
    },
  ) {
    if (user !== this.owner || !this.links.has(user))
      throw new HostRefusedError(
        403,
        "Only the owner of this connection, linked to it, changes it from the host.",
        "Datalayer did not take the change",
      );
    this.changes.push(change);
    if (change.paused !== undefined)
      this.self = { ...this.self, paused: change.paused };
    if (change.channel)
      this.self = {
        ...this.self,
        channels: [
          ...this.self.channels.filter((one) => one.id !== change.channel!.id),
          { deployment: "", ...change.channel },
        ],
      };
    return { paused: this.self.paused };
  }
  /** The deliveries acknowledged, and the webhook registered at a bind. */
  acknowledged: string[] = [];
  webhooks: Array<{ hostKey: string; url: string }> = [];
  refuseWebhook = false;
  // `self` is a field above for tests to change; the client method reads it.
  readonly client = {
    acknowledge: async (_hostKey: string, uid: string) => {
      this.acknowledged.push(uid);
    },
    setWebhook: async (hostKey: string, url: string) => {
      if (this.refuseWebhook)
        throw new HostRefusedError(
          503,
          "unavailable",
          "Datalayer did not register the delivery address",
        );
      this.webhooks.push({ hostKey, url });
      return { signingSecret: "delivery-secret-for-tests", version: 1 };
    },
    admin: (
      hostKey: string,
      user: string,
      change: {
        paused?: boolean;
        channel?: { id: string; state: "allow" | "deny" };
      },
    ) => this.admin(hostKey, user, change),
    bind: (input: { code: string; externalId: string }) => this.bind(input),
    linkCode: (hostKey: string, user: string) => this.linkCode(hostKey, user),
    linkState: (hostKey: string, user: string) => this.linkState(hostKey, user),
    self: async () => this.self,
    uninstalled: (hostKey: string) => this.uninstalled(hostKey),
    unlink: (hostKey: string, user: string) => this.unlink(hostKey, user),
  };
}

/** A turn the fake agent streams: events, with time passing between them. */
export type Script = ReadonlyArray<SemanticEvent | { wait: number }>;

/**
 * The agent client: records each turn, streams a script, or refuses; and
 * the targets the session was mapped with, as `HttpAgentClient` maps them
 * (through `discordShape.targetOf`: at the start, then on each `bindSession`).
 */
export class FakeAgent
  implements AgentClient<DiscordTurn>, SessionBinder<DiscordTurn>
{
  readonly started: HostTurnRequest<DiscordTurn>[] = [];
  readonly targets: Array<{
    sessionId: string;
    target: Record<string, unknown>;
  }> = [];
  readonly stopped: string[] = [];
  script: Script = [{ kind: "text", text: "Hello." }, { kind: "completion" }];
  refuse?: Error;
  /** Called when a turn starts, before its stream: what a concurrency test waits on. */
  onStart?: () => Promise<void>;

  constructor(readonly clock: FakeClock) {}

  async startTurn(request: HostTurnRequest<DiscordTurn>): Promise<TurnStream> {
    this.started.push(request);
    if (this.refuse) throw this.refuse;
    await this.onStart?.();
    const script = this.script;
    const clock = this.clock;
    const run: { id?: string } = {};
    const sessionId = request.sessionId ?? `discord-${"0".repeat(40)}`;
    this.targets.push({ sessionId, target: discordShape.targetOf(request) });
    return {
      run,
      sessionId,
      updates: (async function* () {
        for (const step of script) {
          if ("wait" in step) {
            clock.advance(step.wait);
            continue;
          }
          run.id = "run-1";
          yield step;
        }
      })(),
    };
  }

  async stopTurn(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  async bindSession(
    sessionId: string,
    request: HostTurnRequest<DiscordTurn>,
  ): Promise<boolean> {
    this.targets.push({ sessionId, target: discordShape.targetOf(request) });
    return true;
  }
}

/** An installation as the callback stores it. */
export function installation(
  cipher: SecretCipher,
  overrides: Partial<Installation> = {},
): Installation {
  const guildId = overrides.guildId ?? GUILD;
  return {
    applicationId: APPLICATION,
    guildId,
    hostKey: cipher.encrypt("dlhk_test_key", `${APPLICATION}:${guildId}`),
    hostUid: `host-${guildId}`,
    installedBy: "account-1",
    organizationUid: "account-1",
    permissions: "309237763136",
    state: "active",
    ...overrides,
  };
}

/** Agent Runtimes' shared fixture: what the ai-agents host routes answer. */
export const CONTRACTS = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      "@datalayer/agent-runtimes/lib/portable/hosts/contracts.json",
    ),
    "utf8",
  ),
) as { presentation: { example: unknown } };

/** An approval's presentation, built from the shared contract's example by its real schema. */
export function presentation(
  overrides: Partial<ApprovalPresentation> = {},
): ApprovalPresentation {
  return presentationSchema.parse({
    ...(CONTRACTS.presentation.example as object),
    ...overrides,
  });
}

/**
 * Datalayer as one member: the approvals they may read and decide (each
 * owned by one Discord member) and a session's last answer.
 */
export class FakeAsPerson implements AsPerson {
  /** Approvals by id: the presentation and the Discord member it waits on. */
  readonly approvals = new Map<
    string,
    { presentation: ApprovalPresentation; owner: string }
  >();
  readonly decisions: Array<{
    approvalId: string;
    user: string;
    approve: boolean;
    digest: string;
    note?: string;
  }> = [];
  readonly reads: Array<{ approvalId: string; user: string }> = [];
  answers = new Map<string, string | undefined>();

  #owned(person: Person, approvalId: string) {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.owner !== person.userId)
      throw new HostRefusedError(
        404,
        "Not found.",
        "Datalayer did not answer the approval",
      );
    return approval;
  }

  async presentation(person: Person, approvalId: string) {
    this.reads.push({ approvalId, user: person.userId });
    return this.#owned(person, approvalId).presentation;
  }

  async decide(
    person: Person,
    approvalId: string,
    decision: { approve: boolean; digest: string; note?: string },
  ) {
    const approval = this.#owned(person, approvalId);
    if (approval.presentation.status !== "pending")
      throw new HostRefusedError(
        409,
        "Already decided.",
        "Datalayer did not take the decision",
      );
    if (approval.presentation.digest !== decision.digest)
      throw new HostRefusedError(
        409,
        "The approval changed.",
        "Datalayer did not take the decision",
      );
    this.decisions.push({ approvalId, user: person.userId, ...decision });
    const status = decision.approve ? "approved" : "rejected";
    approval.presentation = { ...approval.presentation, status };
    return { status };
  }

  async lastAnswer(_person: Person, sessionUid: string) {
    return this.answers.get(sessionUid);
  }
}
