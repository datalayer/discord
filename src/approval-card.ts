import {
  hostMayDecide,
  renderApproval,
  type ApprovalPresentation,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { MessageBody } from "./discord-port.js";

import {
  CONTENT_LIMIT,
  decisionNotice,
  EMBED_DESCRIPTION_LIMIT,
  EMBEDS_TOTAL_LIMIT,
  escapeMarkdown,
  NO_MENTIONS,
  OPEN_LABEL,
} from "./render.js";

/**
 * Discord's approval card and thread line (plans/DISCORD.md §3.6, DC-302,
 * DC-303): the thread shows only that a decision waits for its owner, with
 * *Show the request*; the card itself — every material value whole — is
 * shown to its owner alone, in the press's ephemeral `@original`. *Approve*
 * and *Reject* are offered only for what the server says a host may decide
 * (`hostMayDecide`), a renderer shows whole (`renderApproval`: Mail only)
 * and Discord's limits hold; anything else offers *Review in Datalayer*.
 */

/** Discord allows ten embeds per message. */
const EMBEDS_PER_MESSAGE = 10;

const ACTION_WORDS: Record<ApprovalPresentation["action_class"], string> = {
  delete: "delete something",
  execute: "run something",
  financial: "move money",
  publish: "publish something",
  read: "read something",
  send: "send something",
  unknown: "use a tool",
  write: "change something",
};

export const SHOW_LABEL = "Show the request";
export const REVIEW_LABEL = "Review in Datalayer";
export const APPROVE_LABEL = "Approve";
export const REJECT_LABEL = "Reject";

/** What is shown of an action: the renderer's fields, else the presentation's, else its arguments. */
export function shownFields(
  presentation: ApprovalPresentation,
): Array<{ label: string; value: string }> {
  const typed = renderApproval(presentation);
  if (typed.fields.length > 0) return [...typed.fields];
  if (presentation.fields.length > 0)
    return presentation.fields.map(({ label, value }) => ({ label, value }));
  return Object.keys(presentation.arguments).length === 0
    ? []
    : [
        {
          label: "Arguments",
          value: JSON.stringify(presentation.arguments, null, 2),
        },
      ];
}

/**
 * The values as embed descriptions, each value whole and never cut inside
 * one description but continued in the next: `undefined` when they do not
 * fit Discord's limits (ten embeds, 4096 per description, 6000 together).
 */
export function embedsOf(
  fields: ReadonlyArray<{ label: string; value: string }>,
): string[] | undefined {
  const pieces = fields.flatMap(({ label, value }) => [
    `**${escapeMarkdown(label)}**`,
    escapeMarkdown(value) || "(empty)",
  ]);
  const descriptions: string[] = [];
  let current = "";
  for (const piece of pieces) {
    let rest = piece;
    while (rest) {
      const room = EMBED_DESCRIPTION_LIMIT - current.length - (current ? 1 : 0);
      if (rest.length <= room) {
        current = current ? `${current}\n${rest}` : rest;
        rest = "";
        continue;
      }
      // A label starts a new description; a long value continues in the
      // next one, cut never between a backslash and what it escapes.
      if (current && (rest.startsWith("**") || room < 64)) {
        descriptions.push(current);
        current = "";
        continue;
      }
      let cut = room;
      let slashes = 0;
      while (rest[cut - 1 - slashes] === "\\") slashes += 1;
      if (slashes % 2 === 1) cut -= 1;
      descriptions.push(
        current ? `${current}\n${rest.slice(0, cut)}` : rest.slice(0, cut),
      );
      current = "";
      rest = rest.slice(cut);
    }
  }
  if (current) descriptions.push(current);
  const total = descriptions.reduce((sum, one) => sum + one.length, 0);
  if (descriptions.length > EMBEDS_PER_MESSAGE || total > EMBEDS_TOTAL_LIMIT)
    return undefined;
  return descriptions;
}

export type CardIds = Readonly<{
  approve: string;
  reject: string;
  open: string;
}>;

export type ApprovalCard = Readonly<{
  body: MessageBody;
  /** Whether it offers Approve and Reject: a whole, decidable action only. */
  offersDecision: boolean;
}>;

const button = (customId: string, label: string, style: number) => ({
  custom_id: customId,
  label,
  style,
  type: 2,
});

/** The card its owner sees (ephemeral in a server, posted in a DM). */
export function approvalCard(
  presentation: ApprovalPresentation,
  context: Readonly<{ appName: string; ids: CardIds; flags?: number }>,
): ApprovalCard {
  const app = context.appName || "Your application";
  const headline = `**${escapeMarkdown(app)}** wants to ${ACTION_WORDS[presentation.action_class]}: ${escapeMarkdown(presentation.tool_name)}`;
  const typed = renderApproval(presentation);
  const descriptions = embedsOf(shownFields(presentation));
  const offersDecision =
    descriptions !== undefined && hostMayDecide(presentation) && typed.complete;
  const why: string[] = [];
  if (!offersDecision) {
    why.push(...typed.reasons);
    if (descriptions === undefined)
      why.push(
        "It is too long to show whole in Discord: read it whole in Datalayer before deciding.",
      );
    if (presentation.secret_fields.length > 0)
      why.push(
        `Withheld from Discord: ${presentation.secret_fields.join(", ")}.`,
      );
    if (!hostMayDecide(presentation))
      why.push(
        ...(presentation.reasons.length > 0
          ? presentation.reasons
          : ["It is decided in Datalayer."]),
      );
  }
  const reasons = [...new Set(why)].map((one) => `-# ${escapeMarkdown(one)}`);
  const content = [headline, ...reasons].join("\n").slice(0, CONTENT_LIMIT);
  return {
    body: {
      allowed_mentions: NO_MENTIONS,
      components: [
        {
          components: offersDecision
            ? [
                button(`dc:approve:${context.ids.approve}`, APPROVE_LABEL, 3),
                button(`dc:reject:${context.ids.reject}`, REJECT_LABEL, 4),
                button(`dc:open:${context.ids.open}`, OPEN_LABEL, 2),
              ]
            : [button(`dc:open:${context.ids.open}`, REVIEW_LABEL, 2)],
          type: 1,
        },
      ],
      content,
      // Too long to show whole: nothing of it is shown, not a cut part.
      embeds: (descriptions ?? []).map((description) => ({ description })),
      ...(context.flags ? { flags: context.flags } : {}),
    },
    offersDecision,
  };
}

/**
 * The thread's line (§3.6, DC-307): the one message that pings, naming the
 * owner alone; *Show the request* opens the card for them.
 */
export function waitingLine(
  appName: string,
  ownerId: string,
  toolName: string,
  showId: string,
): MessageBody {
  return {
    ...decisionNotice(ownerId, toolName, appName),
    components: [
      {
        components: [button(`dc:show:${showId}`, SHOW_LABEL, 1)],
        type: 1,
      },
    ],
  };
}

/** What a terminal status reads as. */
export function statusWords(status: string): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    default:
      return "Already decided";
  }
}

/**
 * The line or card once decided (§3.6): its outcome, by whom when Discord
 * knows them (named, never pinged), and no buttons.
 */
export function decidedBody(
  toolName: string,
  status: string,
  byUserId?: string,
  flags?: number,
): MessageBody {
  const by =
    byUserId && (status === "approved" || status === "rejected")
      ? ` by <@${byUserId}>`
      : "";
  return {
    allowed_mentions: NO_MENTIONS,
    components: [],
    content: `${statusWords(status)}${by}: ${escapeMarkdown(toolName)}.`,
    embeds: [],
    ...(flags ? { flags } : {}),
  };
}
