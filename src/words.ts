import type { ApplicationRefusal } from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * What @Datalayer says in Discord, in one place (no silent degradation —
 * each refusal has its sentence and its repair). The
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
  finishedInDatalayer:
    "@Datalayer finished this request. Its answer is shown in Datalayer only: open it there.",
  removed: "@Datalayer was removed from this server.",
  notOwner:
    "Only an owner of this server's Datalayer connection may do this, and only with Discord's Manage Server permission.",
  alreadyAnswered: "This was already answered.",
  notYours: "This is not yours to answer: it waits on someone else.",
  openNotYours:
    "This opens the conversation of the person who asked. Ask with /ask to have one of your own.",
  openHere:
    "Open your conversation in Datalayer (this link works once, for you, for ten minutes):",
  approvalChanged:
    "This request is no longer the one shown, or it is decided in Datalayer only: review it in Datalayer.",
  cannotPostThread:
    "@Datalayer may not start a thread or post in it here: a server admin gives it Create Public Threads and Send Messages in Threads in this channel.",
  mentionToContinue:
    "Mention @Datalayer with your question to continue: @Datalayer reads only messages that mention it.",
  mentionReliable:
    "Mention @Datalayer in this thread to continue: other messages here do not reach it.",
  notOpener:
    "Only the person who started this thread's session may start it over or switch its application.",
} as const;

/** Who decides an approval, named without a ping (every message parses no mention). */
export function whoDecides(ownerId: string): string {
  return `Only <@${ownerId}> decides this request: it waits on them.`;
}

/** A resolution refusal in Discord's words. */
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
