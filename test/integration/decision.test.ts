import { beforeEach, describe, expect, it } from "vitest";

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
import {
  connected,
  harness,
  press,
  submit,
  type Harness,
} from "../support/worker.js";

/**
 * The confirmation and the decision (plans/DISCORD.md §3.6, DC-303): the
 * submit is the card's owner's only, the approval read again as them, decided
 * once, only while pending and still the presentation shown (its digest);
 * the card and the thread's line then show the outcome without buttons.
 */

const THREAD = id(500);

/** An approval waiting in the thread, its card shown to Alice: the card's render ids. */
async function shown(h: Harness): Promise<{
  approve: string;
  reject: string;
  line: string;
}> {
  await connected(h);
  h.hosts.links.set(BOB, "principal-bob");
  h.asPerson.approvals.set("ap-1", {
    owner: ALICE,
    presentation: presentation(),
  });
  const delivery: DeliveryQueueJob = {
    delivery: {
      delivery: "dlv-1",
      event: "approval.requested",
      payload: {
        approval_id: "ap-1",
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
        tool_name: "send_email",
      },
    },
    hostUid: `host-${GUILD}`,
    kind: "delivery",
  };
  await h.worker.handle(delivery);
  const line = (
    await h.store.approvalComponents(APPLICATION, GUILD, "ap-1")
  )[0]!;
  await h.worker.handle(press(h, "show", line.renderId, ALICE, 901));
  const rows = await h.store.approvalComponents(APPLICATION, GUILD, "ap-1");
  return {
    approve: rows.find((one) => one.kind === "approve")!.renderId,
    line: line.renderId,
    reject: rows.find((one) => one.kind === "reject")!.renderId,
  };
}

describe("the decision (DC-303)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("decides once as the owner, with the note, and shows the outcome on the card and the thread's line without buttons", async () => {
    const card = await shown(h);
    h.port.calls.length = 0;
    await h.worker.handle(submit(h, true, card.approve, ALICE, 910, "Go."));
    expect(h.asPerson.decisions).toEqual([
      {
        approvalId: "ap-1",
        approve: true,
        digest: presentation().digest,
        note: "Go.",
        user: ALICE,
      },
    ]);
    const edited = h.port.bodies("editOriginal")[0]!;
    expect(edited).toMatchObject({
      components: [],
      content: `Approved by <@${ALICE}>: send\\_email.`,
    });
    expect(edited.allowed_mentions).toEqual({ parse: [] });
    const [where, , line] = h.port.calls.find(
      (call) => call.method === "editMessage",
    )!.args as [string, string, Record<string, unknown>];
    expect(where).toBe(THREAD);
    expect(line).toMatchObject({
      components: [],
      content: `Approved by <@${ALICE}>: send\\_email.`,
    });
  });

  it("takes a double submit once: the second is told it was already answered", async () => {
    const card = await shown(h);
    await h.worker.handle(submit(h, true, card.approve, ALICE, 911));
    h.port.calls.length = 0;
    await h.worker.handle(submit(h, false, card.reject, ALICE, 912));
    expect(h.asPerson.decisions).toHaveLength(1);
    expect(h.port.bodies("followUp")[0]!.content).toBe(WORDS.alreadyAnswered);
    expect(h.port.count("editMessage")).toBe(0);
  });

  it("refuses another member's submit, even with the card's own ids, and decides nothing", async () => {
    const card = await shown(h);
    h.port.calls.length = 0;
    await h.worker.handle(submit(h, true, card.approve, BOB, 913));
    expect(h.asPerson.decisions).toEqual([]);
    expect(h.port.bodies("followUp")[0]!.content).toBe(whoDecides(ALICE));
    expect(h.port.count("editOriginal")).toBe(0);
    // Alice still decides it afterwards: nothing was claimed for Bob.
    await h.worker.handle(submit(h, false, card.reject, ALICE, 914));
    expect(h.asPerson.decisions.map((one) => one.approve)).toEqual([false]);
  });

  it("decides nothing for an approval that expired: the card and the line say Expired", async () => {
    const card = await shown(h);
    h.asPerson.approvals.set("ap-1", {
      owner: ALICE,
      presentation: presentation({ status: "expired" }),
    });
    h.port.calls.length = 0;
    await h.worker.handle(submit(h, true, card.approve, ALICE, 915));
    expect(h.asPerson.decisions).toEqual([]);
    expect(h.port.bodies("editOriginal")[0]!.content).toBe(
      "Expired: send\\_email.",
    );
    expect(h.port.bodies("editMessage")[0]!.content).toBe(
      "Expired: send\\_email.",
    );
  });

  it("decides nothing when the approval changed since the card was shown, and lets a fresh card decide", async () => {
    const card = await shown(h);
    h.asPerson.approvals.set("ap-1", {
      owner: ALICE,
      presentation: presentation({ digest: "1".repeat(64) }),
    });
    h.port.calls.length = 0;
    await h.worker.handle(submit(h, true, card.approve, ALICE, 916));
    expect(h.asPerson.decisions).toEqual([]);
    expect(h.port.bodies("followUp")[0]!.content).toBe(WORDS.approvalChanged);
    expect(h.port.count("editMessage")).toBe(0);
    // Shown again (the new digest), it is decided: the claim was released.
    await h.worker.handle(press(h, "show", card.line, ALICE, 917));
    const fresh = (await h.store.approvalComponents(APPLICATION, GUILD, "ap-1"))
      .filter((one) => one.kind === "reject")
      .at(-1)!;
    await h.worker.handle(submit(h, false, fresh.renderId, ALICE, 918));
    expect(h.asPerson.decisions).toMatchObject([
      { approve: false, digest: "1".repeat(64) },
    ]);
  });

  it("refuses a submit naming a component it never made", async () => {
    await shown(h);
    h.port.calls.length = 0;
    await h.worker.handle(submit(h, true, "AAAAAAAAAAAAAAAA", ALICE, 919));
    expect(h.asPerson.decisions).toEqual([]);
    expect(h.port.bodies("followUp")[0]!.content).toBe(
      "This button no longer does anything.",
    );
  });
});
