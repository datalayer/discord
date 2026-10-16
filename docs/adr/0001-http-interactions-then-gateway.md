# ADR 0001: HTTP interactions and a queue first; a gateway role in Phase 2

Status: accepted, 16 October 2026 (plans/DISCORD.md DC-002): proposed and
acknowledged by the user the same day.

## Context

Discord delivers application commands, components and modals either to an
HTTPS endpoint or over the gateway, never both once an endpoint is set.
Mentions and direct messages arrive only over the gateway. An interaction
must be answered within three seconds and is never retried.

## Decision

- Interactions over HTTP (`/discord/interactions`): verify, persist and defer
  within three seconds, then work from a durable PostgreSQL queue (the shared
  host kit's `PostgresWorkQueue`, `discord_` prefix). Stateless pods behind
  the ingress.
- From Phase 2, one gateway role for mentions and direct messages, holding
  the connection under a PostgreSQL advisory lock, with the three
  non-privileged intents `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES` (the
  user's decision, §15, 3). Interactions stay on HTTP.
- `discord-interactions` for signatures, `discord-api-types` for payloads,
  `@discordjs/ws` and `@discordjs/core` for the gateway role (Phase 2).
- REST over `fetch` with the service's own bucket-aware limiter
  (`src/rate-limit.ts`; amended 16 October 2026, DC-105): the service calls
  eight routes, and the plan needs every 429 to reach the limiter (counted
  by scope, the invalid-request budget) with a bounded retry, which
  `@discordjs/rest`'s internal queue and retries hide. The limiter reads
  `X-RateLimit-Remaining`/`Reset-After` per route, the global flag and
  `retry_after`, and is tested with a fake clock.

## Rejected

- **The full `discord.js` client**: its cache of guilds, channels and members
  assumes one long-lived process; it fits stateless pods poorly and keeps
  data the service does not need.
- **Interactions over the gateway**: one connection would carry every
  interaction, so a reconnect loses deadlines, and the role could not scale
  out.
- **Python**: the Slack service is TypeScript; the shared host kit
  (agent-runtimes `src/portable/hosts`) is TypeScript; a Python service would
  copy it.

## Consequences

The interactions endpoint must be deployed before the portal accepts its URL
(Discord sends a PING). Mentions and DMs wait for Phase 2. A failed
persistence is answered with an ephemeral refusal, since Discord does not
retry.
