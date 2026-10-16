# Operating @Datalayer for Discord

The service's settings, roles, health, database and image
(the landing's `plans/DISCORD.md` §10, DC-008). It
refuses to start when a setting below is missing or malformed, and says which
one.

## Settings

| Setting                                | Required                                     | What it is                                                                                                                       |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                             | yes                                          | `development`, `test` or `production`.                                                                                           |
| `PORT`                                 | no (3000)                                    | The HTTP port every role listens on.                                                                                             |
| `DATALAYER_DISCORD_ROLE`               | yes                                          | `ingress` (Discord's signed requests, persisted), `worker` (the durable queue, the outbox) or `all` (both: development, tests).  |
| `DATABASE_URL`                         | in production, and for `ingress` or `worker` | The service's PostgreSQL (CNPG on r1). Without it, development runs on memory.                                                   |
| `DISCORD_APPLICATION_ID`               | yes                                          | The Discord application's id (a snowflake).                                                                                      |
| `DISCORD_PUBLIC_KEY`                   | yes                                          | Its Ed25519 public key, 64 hex characters: every interaction is verified with it.                                                |
| `DISCORD_BOT_TOKEN`                    | yes                                          | The bot token. Kept in the `datalayer-discord-env` Secret and in memory only; never in the database, a log, a metric or a trace. |
| `DISCORD_CLIENT_SECRET`                | yes                                          | The OAuth2 client secret, for the install's code exchange.                                                                       |
| `DISCORD_TOKEN_ENCRYPTION_KEY`         | yes                                          | Base64 of 32 bytes: the AES-256-GCM key host keys and interaction tokens are encrypted with at rest.                             |
| `DISCORD_TOKEN_ENCRYPTION_KEY_VERSION` | yes                                          | The key's version, kept beside every value it encrypted.                                                                         |
| `DISCORD_APP_URL`                      | yes                                          | This service's public HTTPS origin: the install page, the OAuth callback and the delivery webhook live under it.                 |
| `DATALAYER_API_URL`                    | yes                                          | Datalayer's API origin (HTTPS), where ai-agents' host routes answer (r1 for the pilot).                                          |
| `DATALAYER_WEB_URL`                    | yes                                          | Datalayer's web origin (HTTPS): `/hosts/link`, `/hosts/open`, `/docs/discord`.                                                   |
| `DATALAYER_DELIVERY_POLL_SECONDS`      | no (30)                                      | How often a worker reads the outbox; 0 never.                                                                                    |

`DATALAYER_DISCORD_LOG_SALT` (optional) salts the pseudonyms of logs and
spans; by default `datalayer-discord`.

## Roles and health

Every role answers `GET /healthz` (the process answers) and `GET /readyz`
(its store and queue answer; never Discord or Datalayer, so an outage of
either does not take the pods out of service). Anything else answers 404
until its box lands (`/discord/interactions`, DC-102; the install pages and
events, DC-103; deliveries, DC-301).

## Database

`node dist/migrate.js` (in development `npm run migrate`) applies the shared
host tables first — `discord_event_claims`, `discord_jobs`, `discord_usage`,
`discord_payload_access`, `discord_job_replays`, from agent-runtimes'
`hostSchemaSql("discord")` — then `migrations/`, every time; each statement
is idempotent.

Dead jobs: `DATALAYER_OPERATOR=<your name> node dist/dead-letters.js list |
replay <id> | payload <id> <reason>`. `list` shows metadata and a hash of each
payload, never its words; every replay and payload read is kept with its
operator.

## What runs, and the image

The service runs as one esbuild bundle (`npm run bundle`: `dist/index.js`,
`dist/migrate.js`, `dist/dead-letters.js`) of its sources and agent-runtimes'
`lib/portable` modules they reach; its `dependencies` stay external. The gate
(`npm run check:imports`, in memory) refuses any bundled module that is not
the service's or agent-runtimes' `lib/portable`, any external that is not a
`node:` builtin or a dependency, and anything Jupyter, React, Primer or
Reactor. `@datalayer/agent-runtimes` is an optional peer, pinned in
`config.agentRuntimesVersion`: in the monorepo its `watch:lib` serves
`lib/portable`; in a standalone clone, CI and the image,
`npm run fetch:agent-runtimes` extracts that release's `lib/portable` only,
after every `npm install`.

The image is built from a clean `git archive` export (`make image`): the build
stage installs, fetches and bundles; the runtime stage installs the externals
only (`--omit=dev --omit=peer`), runs as a non-root user and starts
`node dist/index.js`.
