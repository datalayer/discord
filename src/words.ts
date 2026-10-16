import type { ApplicationRefusal } from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * What @Datalayer says in Discord, in one place (plans/DISCORD.md §2, 10: no
 * silent degradation — each refusal has its sentence and its repair). The
 * landing's `/docs/discord` troubleshooting section names the same cases.
 */
export const WORDS = {
  notConnected:
    "This server is not connected to Datalayer. An owner of a Datalayer application adds @Datalayer from Ship → Discord in Datalayer.",
  paused:
    "@Datalayer is paused in this server by its Datalayer owner. Ask them to resume it from Ship → Discord in Datalayer.",
  notLinked:
    "Link your Datalayer account first: run `/datalayer link`, sign in to Datalayer and confirm. Then ask again.",
  directLater:
    "Direct messages to @Datalayer come later. Use `/ask` in a server where @Datalayer is added.",
  busy: "A turn is already running in this thread. Press Stop on it, or wait for it to finish.",
  switchExplicitly:
    "This thread runs another application. Run `/datalayer app` to switch, which starts a new session here.",
  refusedByDatalayer:
    "Datalayer refused this request for your account: you may not open this application here. Ask its owner for access.",
  failed:
    "@Datalayer could not finish this request. Nothing more was done; try again in a moment.",
  waitsInDatalayer:
    "This answer takes longer than Discord lets @Datalayer answer here, and @Datalayer cannot post in this channel. It waits in Datalayer: open the application there.",
  private: "The answer holds something private, so it is shown only to you.",
  privateAfterExpiry:
    "The answer holds something private and Discord no longer lets @Datalayer show it only to you. Open it in Datalayer.",
  endedEarly: "The run ended without an answer.",
  removed: "@Datalayer was removed from this server.",
  notOwner:
    "Only an owner of this server's Datalayer connection may do this, and only with Discord's Manage Server permission.",
  alreadyAnswered: "This was already answered.",
  notYours: "This is not yours to answer: it waits on someone else.",
} as const;

/** A resolution refusal in Discord's words (§8). */
export function refusalWords(refusal: ApplicationRefusal): string {
  switch (refusal) {
    case "channel-denied":
      return "@Datalayer does not answer in this channel: its Datalayer owner denied it. Ask in another channel.";
    case "no-application":
      return "No application answers here yet. Run `/datalayer app` to choose one, or ask the owner to set a default.";
    case "not-allowed":
      return "That application is not one this server allows. Run `/datalayer app` to see those it does.";
    case "direct-only":
      return "That application answers only in direct messages, not in a channel or a thread.";
  }
}
