import type { ApprovalPresentation } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { beforeEach, describe, expect, it } from "vitest";

import { approvalCard, embedsOf } from "../../src/approval-card.js";
import type { DeliveryQueueJob } from "../../src/deliveries.js";
import { targetOf } from "../../src/domain.js";
import { WORDS, whoDecides } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  CHANNEL,
  GUILD,
  id,
  presentation,
} from "../support/discord.js";
import { connected, harness, press, type Harness } from "../support/worker.js";

/**
 * The approval card and *Show the request* (plans/DISCORD.md §3.6, DC-302):
 * the thread shows only that a decision waits; a press of *Show the request*
 * is deferred privately and its `@original` filled with the card for the
 * person it waits on, read as them; anyone else is told who decides; the
 * thread's line is never changed by a press. Approve and Reject only for a
 * whole Mail action within Discord's limits; every other class fails closed
 * to *Review in Datalayer*.
 */

const THREAD = id(500);

async function waiting(
  h: Harness,
  shown: ApprovalPresentation = presentation(),
): Promise<string> {
  await connected(h);
  h.hosts.links.set(BOB, "principal-bob");
  await h.store.setAllowances(APPLICATION, GUILD, [
    {
      applicationId: "deployment-1",
      channelPolicy: "channels",
      enabled: true,
      name: "Launch Review",
    },
  ]);
  h.asPerson.approvals.set(shown.approval_id, {
    owner: ALICE,
    presentation: shown,
  });
  const delivery: DeliveryQueueJob = {
    delivery: {
      delivery: "dlv-1",
      event: "approval.requested",
      payload: {
        approval_id: shown.approval_id,
        deployment_uid: "deployment-1",
        presentation: "v1",
        session_uid: "discord-session",
        target: targetOf({
          key: {
            applicationId: APPLICATION,
            channelId: CHANNEL,
            guildId: GUILD,
            thread: THREAD,
          },
          messageId: THREAD,
          private: false,
          threadExists: true,
          userId: ALICE,
        }),
        tool_name: shown.tool_name,
      },
    },
    hostUid: `host-${GUILD}`,
    kind: "delivery",
  };
  await h.worker.handle(delivery);
  const [row] = await h.store.approvalComponents(
    APPLICATION,
    GUILD,
    shown.approval_id,
  );
  return row!.renderId;
}

/** The custom ids of the buttons of a message body. */
const buttonsOf = (body: { components?: readonly unknown[] }) =>
  JSON.stringify(body.components ?? [])
    .match(/dc:[a-z-]+:[A-Za-z0-9_-]+/g)
    ?.map((one) => one.split(":")[1]) ?? [];

describe("Show the request (DC-302)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("fills the owner's press with the whole card, read as them: Approve, Reject and Open in Datalayer", async () => {
    const show = await waiting(h);
    await h.worker.handle(press(h, "show", show, ALICE, 901));
    expect(h.asPerson.reads).toEqual([{ approvalId: "ap-1", user: ALICE }]);
    const card = h.port.bodies("editOriginal")[0]!;
    expect(card.content).toBe(
      "**Launch Review** wants to send something: send\\_email",
    );
    const embeds = JSON.stringify(card.embeds);
    for (const value of ["release@example.com", "Launch decision", "option B"])
      expect(embeds).toContain(value);
    expect(buttonsOf(card)).toEqual(["approve", "reject", "open"]);
    // Answered privately; the thread's line is unchanged by a press.
    expect(h.port.count("editMessage")).toBe(0);
    expect(h.port.count("deleteOriginal")).toBe(0);
  });

  it("tells anyone else who decides, privately, without reading the approval or pinging", async () => {
    const show = await waiting(h);
    await h.worker.handle(press(h, "show", show, BOB, 902));
    expect(h.asPerson.reads).toEqual([]);
    const said = h.port.bodies("editOriginal")[0]!;
    expect(said.content).toBe(whoDecides(ALICE));
    expect(said.allowed_mentions).toEqual({ parse: [] });
    expect(buttonsOf(said)).toEqual([]);
    expect(h.port.count("editMessage")).toBe(0);
  });

  it("asks an unlinked owner to link first", async () => {
    const show = await waiting(h);
    h.hosts.links.delete(ALICE);
    await h.worker.handle(press(h, "show", show, ALICE, 903));
    expect(h.port.bodies("editOriginal")[0]!.content).toBe(WORDS.notLinked);
    expect(h.asPerson.reads).toEqual([]);
  });

  it("offers no decision for a card too long to show whole in Discord: Review in Datalayer only", async () => {
    const long = "x".repeat(7000);
    const show = await waiting(
      h,
      presentation({
        arguments: {
          body: long,
          subject: "Launch decision",
          to: "release@example.com",
        },
        fields: [
          { label: "To", name: "to", value: "release@example.com" },
          { label: "Subject", name: "subject", value: "Launch decision" },
          { label: "Body", name: "body", value: long },
        ],
      }),
    );
    await h.worker.handle(press(h, "show", show, ALICE, 904));
    const card = h.port.bodies("editOriginal")[0]!;
    expect(buttonsOf(card)).toEqual(["open"]);
    expect(JSON.stringify(card.components)).toContain("Review in Datalayer");
    expect(card.content).toContain("too long to show whole in Discord");
    // Nothing of it is shown, not a cut part.
    expect(card.embeds).toEqual([]);
  });

  it("shows a value longer than one embed whole across embeds, and keeps the decision", () => {
    const body = "word ".repeat(1000).trim();
    const descriptions = embedsOf([{ label: "Body", value: body }])!;
    expect(descriptions.length).toBe(2);
    expect(descriptions.join("").replace("**Body**\n", "")).toBe(body);
    const card = approvalCard(
      presentation({
        arguments: { body, subject: "S", to: "a@example.com" },
        fields: [
          { label: "To", name: "to", value: "a@example.com" },
          { label: "Subject", name: "subject", value: "S" },
          { label: "Body", name: "body", value: body },
        ],
      }),
      { appName: "App", ids: { approve: "a", open: "o", reject: "r" } },
    );
    expect(card.offersDecision).toBe(true);
  });

  it("fails closed for every action that is not mail: Review in Datalayer only", () => {
    const classes: Array<ApprovalPresentation["action_class"]> = [
      "read",
      "write",
      "execute",
      "publish",
      "delete",
      "financial",
      "unknown",
    ];
    for (const action_class of classes) {
      const card = approvalCard(
        presentation({ action_class, host_may_decide: false }),
        { appName: "App", ids: { approve: "a", open: "o", reject: "r" } },
      );
      expect(card.offersDecision, action_class).toBe(false);
      expect(buttonsOf(card.body), action_class).toEqual(["open"]);
    }
    // A send that is not mail, a secret field, a stale version: closed too.
    for (const shown of [
      presentation({ tool_name: "post_to_slack" }),
      presentation({ secret_fields: ["body"] }),
      presentation({ version: 2 }),
      presentation({ complete: false }),
    ]) {
      const card = approvalCard(shown, {
        appName: "App",
        ids: { approve: "a", open: "o", reject: "r" },
      });
      expect(card.offersDecision, shown.tool_name).toBe(false);
    }
  });
});
