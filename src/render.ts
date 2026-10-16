import {
  redact,
  type TurnState,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { MessageBody } from "./discord-port.js";

/**
 * Discord messages within Discord's limits (DC-306, DC-307):
 * answers split at 2000 characters without breaking a link,
 * mentions never parsed but for a decision notice naming its owner, routine
 * posts silent in quiet mode, and the status line under a running answer.
 */

/** Whether a text holds a credential-shaped value (the shared redaction's shapes). */
export function secretBearing(text: string): boolean {
  return redact(text) !== text;
}

/** A message's content limit. */
export const CONTENT_LIMIT = 2000;
/** An embed description's limit, and all of a message's embeds together. */
export const EMBED_DESCRIPTION_LIMIT = 4096;
export const EMBEDS_TOTAL_LIMIT = 6000;

/** Message flags the service sets. */
export const EPHEMERAL = 1 << 6;
export const SUPPRESS_NOTIFICATIONS = 1 << 12;

/** Nothing pinged: every message but a decision notice. */
export const NO_MENTIONS = { parse: [] } as const;

/** How a server hears @Datalayer (DC-307): routine posts silent, or not. */
export type NotificationMode = "quiet" | "noisy";

/**
 * `@everyone`, `@here` and role or user mentions written by a model or a
 * tool, shown as text: a zero-width joiner after the `@`, on top of
 * `allowed_mentions: {parse: []}`, so a copy pasted elsewhere does not ping
 * either.
 */
export function inertMentions(text: string): string {
  return text
    .replace(/@(everyone|here)\b/g, "@​$1")
    .replace(/<@([!&]?\d{17,20})>/g, "<@​$1>");
}

/** Where a split may not fall: inside a Markdown link or a bare URL. */
const UNBREAKABLE = /\[[^\]\n]{1,300}\]\(https?:\/\/[^\s)]+\)|https?:\/\/\S+/g;

/**
 * Split text into chunks of at most `limit` characters: at a blank line, else
 * a line end, else a space, never inside a link (a link longer than the
 * limit is cut only as a last resort).
 */
export function splitText(text: string, limit = CONTENT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const protectedRanges = [...rest.matchAll(UNBREAKABLE)].map((match) => [
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    ]);
    const inside = (at: number) =>
      protectedRanges.some(([start, end]) => at > start! && at < end!);
    let cut = -1;
    for (const separator of ["\n\n", "\n", " "]) {
      let at = rest.lastIndexOf(separator, limit);
      while (at > 0 && inside(at)) at = rest.lastIndexOf(separator, at - 1);
      if (at > 0) {
        cut = at;
        break;
      }
    }
    if (cut <= 0) {
      const covering = protectedRanges.find(
        ([start, end]) => limit > start! && limit < end!,
      );
      cut = covering && covering[0]! > 0 ? covering[0]! : limit;
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The tail of a running answer that fits beside its status line. */
function tailOf(text: string, room: number): string {
  if (text.length <= room) return text;
  return `…${text.slice(text.length - room + 1)}`;
}

/** How many words a running answer has so far. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * A running turn's message: its status and Stop, and the answer so far only
 * where its person alone reads it. Where others read (`publicly`)
 * a running answer is never shown, only how far it has come: whether it
 * bears something private is known only once it is whole, so the whole
 * answer is shown then, once checked, and nothing of a secret-bearing one
 * ever was.
 */
export function progressBody(
  state: TurnState,
  stopId: string | undefined,
  flags = 0,
  publicly = false,
): MessageBody {
  const words = wordCount(state.answer);
  // The status line is the runtime's words: where others read, any
  // credential in it is masked (the whole output is checked at the end).
  const status = `-# ${publicly ? String(redact(state.status)) : state.status}${
    publicly && words ? ` · ${words} word${words === 1 ? "" : "s"} so far` : ""
  }`;
  const answer = publicly ? "" : inertMentions(state.answer.trim());
  const content = answer
    ? `${tailOf(answer, CONTENT_LIMIT - status.length - 2)}\n\n${status}`
    : status;
  return {
    allowed_mentions: NO_MENTIONS,
    content,
    ...(stopId
      ? {
          components: [
            {
              components: [
                { custom_id: stopId, label: "Stop", style: 4, type: 2 },
              ],
              type: 1,
            },
          ],
        }
      : { components: [] }),
    ...(flags ? { flags } : {}),
  };
}

/** What a turn ended on, in words, when it has no answer text of its own. */
function endingWords(state: TurnState): string {
  if (state.ending === "stop") return "Stopped.";
  if (state.ending === "error")
    return `Could not finish: ${state.error ?? "the run failed"}.`;
  if (state.asking) return state.asking.prompt;
  return "Done, with nothing to say.";
}

/** The button that opens a turn's session in Datalayer. */
export const OPEN_LABEL = "Open in Datalayer";
/** What `/datalayer start-over` asks to confirm, on its own person's button. */
export const START_OVER_LABEL = "Start over";
/** On a private *Ask Datalayer* answer: post it in the message's thread. */
export const POST_LABEL = "Post in thread";

/**
 * An ended turn's messages: the whole answer split within the limit, the
 * first for `@original` (or the first bot message), the rest after it; no
 * Stop button, the stream's text never repeated (`TurnState` keeps it once).
 * With `openId`, the last carries *Open in Datalayer*, a press that makes
 * the presser's own one-use link (never a link written into the message,
 * which would expire or be spent by another).
 */
export function finalBodies(
  state: TurnState,
  flags = 0,
  openId?: string,
  postId?: string,
): MessageBody[] {
  const answer = inertMentions(state.answer.trim());
  const files = state.files.length
    ? [state.files.map((file) => `[${file.name}](${file.url})`).join("\n")]
    : [];
  const parts = answer
    ? [
        answer,
        ...(state.ending === "stop" ? ["-# Stopped"] : []),
        ...(state.ending === "error"
          ? [`-# Could not finish: ${state.error ?? "the run failed"}`]
          : []),
        ...files,
      ]
    : [endingWords(state), ...files];
  const text = parts.join("\n\n");
  const chunks = splitText(text);
  return chunks.map((content, at) => ({
    allowed_mentions: NO_MENTIONS,
    components:
      (openId || postId) && at === chunks.length - 1
        ? [
            {
              components: [
                ...(openId
                  ? [
                      {
                        custom_id: openId,
                        label: OPEN_LABEL,
                        style: 2,
                        type: 2,
                      },
                    ]
                  : []),
                ...(postId
                  ? [
                      {
                        custom_id: postId,
                        label: POST_LABEL,
                        style: 2,
                        type: 2,
                      },
                    ]
                  : []),
              ],
              type: 1,
            },
          ]
        : [],
    content,
    ...(flags ? { flags } : {}),
  }));
}

/**
 * A routine post (an answer delivered later, a progress note): silent in
 * quiet mode (`SUPPRESS_NOTIFICATIONS`), nobody pinged either way (DC-307).
 */
export function routine(
  content: string,
  mode: NotificationMode,
): MessageBody[] {
  return splitText(inertMentions(content)).map((one) => ({
    allowed_mentions: NO_MENTIONS,
    content: one,
    ...(mode === "quiet" ? { flags: SUPPRESS_NOTIFICATIONS } : {}),
  }));
}

/**
 * Text that is not ours, shown as text: Discord's Markdown characters
 * escaped, mentions inert, so a value can neither format nor ping.
 */
export function escapeMarkdown(text: string): string {
  return inertMentions(text).replace(/([\\*_~`|>#[\]()<:-])/g, "\\$1");
}

/**
 * The one message that pings (DC-307): a decision waits for its owner, who
 * alone is named in `allowed_mentions.users`; nothing parsed.
 */
export function decisionNotice(
  ownerId: string,
  toolName: string,
  appName = "",
): MessageBody {
  if (!/^\d{17,20}$/.test(ownerId))
    throw new Error("A decision notice names a Discord user id.");
  return {
    allowed_mentions: { parse: [], users: [ownerId] },
    content: `<@${ownerId}> ${escapeMarkdown(appName || "Your application")} is waiting for your decision: ${escapeMarkdown(toolName)}.`,
  };
}

/**
 * An ephemeral answer to one person (`/datalayer`, refusals). Text that is
 * not the service's own has its mentions made inert; the service's own
 * words (`ours`) may name a member, shown as their name and never pinged.
 */
export function privately(content: string, ours = false): MessageBody {
  return {
    allowed_mentions: NO_MENTIONS,
    content: splitText(ours ? content : inertMentions(content))[0] ?? "",
    flags: EPHEMERAL,
  };
}
