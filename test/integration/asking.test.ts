import { beforeEach, describe, expect, it } from "vitest";

import { threadIdOf } from "../../src/domain.js";
import type { InteractionJob } from "../../src/interactions.js";
import { ANSWER_LABEL, OPEN_LABEL } from "../../src/render.js";
import { WORDS } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  CHANNEL,
  GUILD,
  id,
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * Questions a turn ends on (`loop.ask`, DC-304): five or fewer choices as
 * buttons for the person who asked, answered once per asking event — the
 * first press answers it and replaces the buttons with what answered, a
 * press of another of its buttons is told so — and the choice their own
 * next turn in the session, posted as the bot in the thread, never over
 * the answered message's text. More than five choices, a
 * text, file or form question, and a kind the service does not know are
 * answered in Datalayer.
 */

const THREAD = id(500);
const CHOICES = ["Ship on Tuesday", "Wait for QA", "Ask the team"];

type Button = { custom_id: string; label: string };

/** The buttons of the last edit of the answer, row by row. */
function rows(h: Harness): Button[][] {
  const body = h.port.bodies("editOriginal").at(-1)!;
  return ((body.components ?? []) as Array<{ components: Button[] }>).map(
    (row) => row.components,
  );
}

/** The labels of those buttons. */
const labels = (h: Harness) =>
  rows(h).map((row) => row.map((one) => one.label));

function press(
  h: Harness,
  customId: string,
  userId = ALICE,
  n = 960,
): InteractionJob {
  const { command, ...job } = h.job({ n, userId });
  void command;
  return {
    ...job,
    component: { kind: "answer", renderId: customId.split(":")[2] ?? "" },
    ephemeral: false,
    threadFromOriginal: false,
    type: 3,
  };
}

describe("a question the turn ends on (DC-304)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await connected(h);
    h.hosts.links.set(BOB, "principal-bob");
  });

  async function asked(question: Record<string, unknown>): Promise<void> {
    h.agent.script = [
      { kind: "text", text: "Two paths are open." },
      { kind: "ask", question } as never,
    ];
    await h.worker.handle(h.job());
    h.agent.script = [{ kind: "text", text: "Noted." }, { kind: "completion" }];
  }

  it("shows five or fewer choices as buttons with their full labels, and answers the first press once: two different buttons give one answer", async () => {
    await asked({ kind: "choice", options: CHOICES, prompt: "Which way?" });
    const [choices, others] = rows(h);
    expect(choices?.map((one) => one.label)).toEqual(CHOICES);
    expect(others?.map((one) => one.label)).toEqual([OPEN_LABEL]);
    expect(h.port.bodies("editOriginal").at(-1)?.content).toContain(
      "Which way?",
    );
    const edits = h.port.count("editOriginal");
    const session = h.agent.targets[0]!.sessionId;

    // Someone else's press answers nothing.
    await h.worker.handle(press(h, choices![0]!.custom_id, BOB, 961));
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.notYours);
    expect(h.agent.started).toHaveLength(1);

    await h.worker.handle(press(h, choices![1]!.custom_id, ALICE, 962));
    // Another of its buttons, pressed after: already answered.
    await h.worker.handle(press(h, choices![2]!.custom_id, ALICE, 963));
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(
      WORDS.alreadyAnswered,
    );
    expect(h.agent.started).toHaveLength(2);
    const turn = h.agent.started[1]!;
    expect(turn.prompt).toBe("Wait for QA");
    expect(turn.externalUserId).toBe(ALICE);
    expect(turn.sessionId).toBe(session);
    expect(turn.provenance.threadExists).toBe(true);
    // The answered message: its buttons replaced by what answered,
    // its text never rewritten; the turn posted as the bot in the thread.
    expect(h.port.count("editOriginal")).toBe(edits + 1);
    const answered = h.port.bodies("editOriginal").at(-1)!;
    expect(answered.content).toBeUndefined();
    expect(labels(h)).toEqual([["✓ Wait for QA"], [OPEN_LABEL]]);
    expect(rows(h)[1]![0]!.custom_id).toBe(others![0]!.custom_id);
    expect(h.port.count("deleteOriginal")).toBe(0);
    const posted = h.port.calls.filter(
      (call) =>
        call.method === "createMessage" || call.method === "editMessage",
    );
    expect(posted.length).toBeGreaterThan(0);
    for (const call of posted) expect(call.args[0]).toBe(THREAD);
    const last = posted.at(-1)!.args.at(-1) as { content?: string };
    expect(last.content).toContain("Noted.");
    expect(
      (
        await h.store.thread(
          threadIdOf({
            applicationId: APPLICATION,
            channelId: CHANNEL,
            guildId: GUILD,
            thread: THREAD,
          }),
        )
      )?.threadExists,
    ).toBe(true);
  });

  it("lists a choice too long for a button whole in the text", async () => {
    const long = `Ship it ${"carefully ".repeat(12)}`.trim();
    await asked({
      kind: "choice",
      options: ["Now", long],
      prompt: "When?",
    });
    const [choices] = rows(h);
    expect(choices).toHaveLength(2);
    expect(choices![1]!.label.length).toBeLessThanOrEqual(80);
    expect(h.port.bodies("editOriginal").at(-1)?.content).toContain(
      `2. ${long}`,
    );
  });

  it("answers more than five choices, a text question and a kind it does not know in Datalayer, with no choice button", async () => {
    await asked({
      kind: "choice",
      options: ["a", "b", "c", "d", "e", "f"],
      prompt: "Pick one",
    });
    expect(labels(h)).toEqual([[ANSWER_LABEL]]);
    expect(h.port.bodies("editOriginal").at(-1)?.content).toContain("6. f");

    const text = harness();
    await connected(text);
    text.agent.script = [
      { kind: "ask", question: { kind: "text", prompt: "Why?" } },
    ];
    await text.worker.handle(text.job());
    expect(labels(text)).toEqual([[ANSWER_LABEL]]);

    const unknown = harness();
    await connected(unknown);
    unknown.agent.script = [
      {
        kind: "ask",
        question: { kind: "vote", options: ["x"], prompt: "Vote?" },
      } as never,
    ];
    await unknown.worker.handle(unknown.job());
    expect(labels(unknown)).toEqual([[ANSWER_LABEL]]);
    expect(unknown.port.bodies("editOriginal").at(-1)?.content).toContain(
      "cannot show this kind of question here",
    );
  });

  it("offers no choice on a private answer: it is answered in Datalayer", async () => {
    h.agent.script = [
      {
        kind: "ask",
        question: { kind: "choice", options: CHOICES, prompt: "Which way?" },
      },
    ];
    await h.worker.handle(
      h.job({
        command: {
          name: "ask",
          options: { private: true, question: "What changed?" },
        },
        ephemeral: true,
      }),
    );
    expect(labels(h)).toEqual([[ANSWER_LABEL]]);
  });
});
