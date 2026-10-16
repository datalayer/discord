import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  discordShape,
  externalIdOf,
  placeOf,
  sessionUidOf,
  targetOf,
} from "../src/domain.js";
import { keyOf } from "../src/interactions.js";

/**
 * The adapter's half of the shared contracts (plans/DISCORD.md §4.3, DC-006):
 * Discord's cases in `contracts.json`, read from agent-runtimes'
 * `lib/portable/hosts` (byte-identical to ai-agents' fixture, which ai-agents'
 * `test_app_hosts` reads), produced by this service's own functions.
 */
const contracts = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      "@datalayer/agent-runtimes/lib/portable/hosts/contracts.json",
    ),
    "utf8",
  ),
) as {
  discord: {
    application_id: string;
    guild_id: string;
    bind_request: { external_id: string };
    external_user_id: string;
    thread: {
      channel: { id: string; type: number; parent_id: string };
      place: { kind: string; id: string };
    };
    direct: {
      channel: { id: string; type: number };
      place: { kind: string; id: string };
    };
    session: { parts: string[]; uid: string };
    target: Record<string, string>;
  };
  external_turn: {
    optional_request: { provenance: Record<string, unknown> };
    provenance_limit_bytes: number;
  };
};
const discord = contracts.discord;

const interactionIn = (channel: object, guild?: string) =>
  ({
    application_id: discord.application_id,
    channel,
    id: "1",
    type: 2,
    ...(guild ? { guild_id: guild } : {}),
  }) as Parameters<typeof keyOf>[0];

describe("Discord's forms of the host contracts (DC-006)", () => {
  it("binds the installation as <application_id>:<guild_id>", () => {
    expect(externalIdOf(discord.application_id, discord.guild_id)).toBe(
      discord.bind_request.external_id,
    );
  });

  it("sends a thread as its parent channel, and the bot's DM as direct", () => {
    const thread = keyOf(
      interactionIn(discord.thread.channel, discord.guild_id),
    ).key;
    expect(placeOf(thread)).toEqual(discord.thread.place);
    const direct = keyOf(interactionIn(discord.direct.channel)).key;
    expect(placeOf(direct)).toEqual(discord.direct.place);
  });

  it("derives the session uid and the delivery target the contract names", () => {
    const thread = keyOf(
      interactionIn(discord.thread.channel, discord.guild_id),
    ).key;
    expect(sessionUidOf(thread)).toBe(discord.session.uid);
    expect(
      targetOf({
        key: thread,
        messageId: discord.target.messageId!,
        private: false,
        threadExists: true,
        userId: discord.external_user_id,
      }),
    ).toEqual(discord.target);
    expect(JSON.stringify(discord.target).length).toBeLessThanOrEqual(2048);
  });

  it("sends the turn's provenance in the contract's shape, within its limit", () => {
    const thread = keyOf(
      interactionIn(discord.thread.channel, discord.guild_id),
    ).key;
    const provenance = discordShape.provenanceOf!({
      applicationId: "dep-1",
      externalEventId: "discord:1",
      externalUserId: discord.external_user_id,
      principalId: "p",
      prompt: "x",
      provenance: {
        key: thread,
        messageId: discord.target.messageId!,
        private: false,
        threadExists: true,
        userId: discord.external_user_id,
      },
    });
    expect(provenance).toEqual(
      contracts.external_turn.optional_request.provenance,
    );
    expect(JSON.stringify(provenance).length).toBeLessThanOrEqual(
      contracts.external_turn.provenance_limit_bytes,
    );
  });
});
