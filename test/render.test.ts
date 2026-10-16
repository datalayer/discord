import { TurnState } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import {
  CONTENT_LIMIT,
  decisionNotice,
  finalBodies,
  inertMentions,
  NO_MENTIONS,
  progressBody,
  routine,
  splitText,
  SUPPRESS_NOTIFICATIONS,
  wordCount,
} from "../src/render.js";
import { ALICE } from "./support/discord.js";

/**
 * Discord messages within Discord's limits (plans/DISCORD.md §3.7, DC-306,
 * DC-307): splits at 2000 without breaking a link, mentions inert and never
 * parsed, routine posts silent in quiet mode, only a decision notice pings,
 * and only its owner.
 */

const state = (...texts: string[]) => {
  const one = new TurnState();
  for (const text of texts) one.apply({ kind: "text", text });
  return one;
};

describe("splitting (DC-306)", () => {
  it("keeps 2000 characters in one message and splits 2001 at a word", () => {
    const exact = "a".repeat(1995) + " bcd";
    expect(splitText(exact)).toEqual([exact]);
    const over = `${"word ".repeat(400)}x`;
    const chunks = splitText(over);
    expect(chunks.every((chunk) => chunk.length <= CONTENT_LIMIT)).toBe(true);
    expect(chunks.join(" ")).toBe(over.trim());
  });

  it("never splits inside a link", () => {
    const link =
      "[the launch review](https://datalayer.ai/docs/a-very-long-path)";
    const text = `${"x ".repeat(980)}${link} after`;
    const chunks = splitText(text);
    expect(chunks.some((chunk) => chunk.includes(link))).toBe(true);
    for (const chunk of chunks)
      expect(chunk.length).toBeLessThanOrEqual(CONTENT_LIMIT);
  });

  it("cuts a word longer than the limit only as a last resort", () => {
    const chunks = splitText("y".repeat(4100));
    expect(chunks.map((chunk) => chunk.length)).toEqual([2000, 2000, 100]);
  });

  it("ends an answer once: the streamed text, never the completion's repeated", () => {
    const one = state("Option B ", "is safer.");
    one.apply({ kind: "completion", text: "Option B is safer." });
    expect(finalBodies(one).map((body) => body.content)).toEqual([
      "Option B is safer.",
    ]);
  });
});

describe("what of a running answer is public (DC-105, §2 rule 5)", () => {
  it("shows where others read only the status and how many words, never the words", () => {
    const state = new TurnState();
    state.apply({ kind: "text", text: "Your key is dlhk_ab" });
    const shown = progressBody(state, "dc:stop:abcdefghijkl", 0, true);
    expect(shown.content).toBe("-# Working… · 4 words so far");
    expect(progressBody(state, undefined, 64).content).toContain(
      "Your key is dlhk_ab",
    );
    expect(wordCount(" one\ntwo\tthree ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("mentions and notifications (DC-307)", () => {
  it("makes @everyone, @here and raw mentions in an answer inert, and parses nothing", () => {
    const one = state(
      `Tell @everyone and @here, and <@${ALICE}> and <@&123456789012345678>.`,
    );
    one.apply({ kind: "completion" });
    const [body] = finalBodies(one);
    expect(body?.content).not.toMatch(/@everyone|@here|<@\d/);
    expect(body?.allowed_mentions).toEqual({ parse: [] });
    expect(progressBody(one, "dc:stop:abcdefghijkl").allowed_mentions).toEqual({
      parse: [],
    });
    expect(inertMentions("@everyone")).toBe("@​everyone");
  });

  it("posts routine messages silently in quiet mode, normally in noisy mode, pinging nobody either way", () => {
    const [quiet] = routine("The report is ready.", "quiet");
    expect(quiet).toEqual({
      allowed_mentions: NO_MENTIONS,
      content: "The report is ready.",
      flags: SUPPRESS_NOTIFICATIONS,
    });
    const [noisy] = routine("The report is ready.", "noisy");
    expect(noisy).toEqual({
      allowed_mentions: NO_MENTIONS,
      content: "The report is ready.",
    });
  });

  it("pings only the owner a decision waits for, with no parse", () => {
    const notice = decisionNotice(ALICE, "send_mail");
    expect(notice.allowed_mentions).toEqual({ parse: [], users: [ALICE] });
    expect(notice.content).toContain(`<@${ALICE}>`);
    expect(() => decisionNotice("@everyone", "x")).toThrow();
  });
});
