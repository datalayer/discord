# ADR 0002: the host exchange, as Slack's

Status: proposed, 16 October 2026 (plans/DISCORD.md DC-002). Awaiting the
user's acknowledgement.

Discord takes the host credential exchange of the Slack service's ADR 0002
(`datalayer/slack` `docs/adr/0002-host-exchange.md`) unchanged: the
installation's host key and the member's Discord id are exchanged at ai-agents
(`POST /apps/hosts/self/token`) for a fifteen-minute host token of the linked
person and one deployment, at every turn, decision and handoff, through the
shared `HostKeyCredentials`. The bot token never stands for a person.

Only Discord's differences are recorded here.

1. **The fifteen-minute interaction token.** An interaction's token is valid
   fifteen minutes, like the host token, but they are unrelated: a long turn
   exchanges again as needed, and its answer moves to the bot token in the
   thread at fourteen minutes (§7.5). Neither token is ever kept beyond its
   life; the interaction token is encrypted while stored.
2. **A thread is sent as its parent channel.** `place` has only `kind` and
   `id` and ignores extra keys, so a thread is sent as
   `{kind: "channel", id: <parent channel id>}`: its policy is its parent's
   (the user's decision, §15, 7), with no server change.

## Rejected

- A Discord-specific exchange route: every host speaks the same contracts.
- Sending the thread's own id as the place: no channel rule would ever match
  it, so a denied channel's threads would be allowed.
