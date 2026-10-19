# Operating @Datalayer for Discord

The service's settings, roles, health, database and image
(DC-008). It
refuses to start when a setting below is missing or malformed, and says which
one.

## Settings

| Setting                                          | Required                                     | What it is                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                       | yes                                          | `development`, `test` or `production`.                                                                                                                                        |
| `PORT`                                           | no (3000)                                    | The HTTP port every role listens on.                                                                                                                                          |
| `DATALAYER_DISCORD_ROLE`                         | yes                                          | `ingress` (Discord's signed requests, persisted), `worker` (the durable queue, the outbox), `gateway` (the one gateway connection) or `all` (every role: development, tests). |
| `DATABASE_URL`                                   | in production, and for `ingress` or `worker` | The service's PostgreSQL (CNPG on r1). Without it, development runs on memory.                                                                                                |
| `DATALAYER_DISCORD_APPLICATION_ID`               | yes                                          | The Discord application's id (a snowflake).                                                                                                                                   |
| `DATALAYER_DISCORD_PUBLIC_KEY`                   | yes                                          | Its Ed25519 public key, 64 hex characters: every interaction is verified with it.                                                                                             |
| `DATALAYER_DISCORD_BOT_TOKEN`                    | yes                                          | The bot token. Kept in the `datalayer-discord-env` Secret and in memory only; never in the database, a log, a metric or a trace.                                              |
| `DATALAYER_DISCORD_CLIENT_SECRET`                | yes                                          | The OAuth2 client secret, for the install's code exchange.                                                                                                                    |
| `DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY`         | yes                                          | Base64 of 32 bytes: the AES-256-GCM key host keys and interaction tokens are encrypted with at rest.                                                                          |
| `DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY_VERSION` | yes                                          | The key's version, kept beside every value it encrypted.                                                                                                                      |
| `DATALAYER_DISCORD_APP_URL`                      | yes                                          | This service's public HTTPS origin: the install page, the OAuth callback and the delivery webhook live under it.                                                              |
| `DATALAYER_API_URL`                              | yes                                          | Datalayer's API origin (HTTPS), where ai-agents' host routes answer (r1 for the pilot).                                                                                       |
| `DATALAYER_WEB_URL`                              | yes                                          | Datalayer's web origin (HTTPS): `/hosts/link`, `/hosts/open`, `/docs/discord`.                                                                                                |
| `DATALAYER_DELIVERY_POLL_SECONDS`                | no (30)                                      | How often a worker reads the outbox; 0 never.                                                                                                                                 |

`DATALAYER_DISCORD_LOG_SALT` (optional) salts the pseudonyms of logs and
spans; by default `datalayer-discord`.

## Roles and health

Every role answers `GET /healthz` (the process answers) and `GET /readyz`
(its store and queue answer; never Discord or Datalayer, so an outage of
either does not take the pods out of service). Anything else answers 404
until its box lands (`/discord/interactions`, DC-102; the install pages and
events, DC-103; deliveries, DC-301).

The `gateway` role (DC-201) holds the application's one connection to
Discord's gateway. Every replica tries a PostgreSQL advisory lock on a
connection of its own (`discord-gateway:<application id>`); the one that
takes it connects, the others try again every 15 seconds. The lock is
checked every 10 seconds: lost (its connection ended), the connection is
closed at once, so two replicas never hold a session together. It
identifies with GUILDS, GUILD_MESSAGES and DIRECT_MESSAGES only (no
privileged intent), spends identifies within `GET /gateway/bot`'s budget,
heartbeats and resumes, and queues each mention of the bot, direct message
and reply to its messages once by message id (`message:<id>`); the worker
answers them. Logs: `gateway.leading`, `gateway.ready`, `gateway.resumed`,
`gateway.lock_lost`, `gateway.closed`. It needs Node 22 (its `WebSocket`).

## Database

`node dist/migrate.js` (in development `npm run migrate`) applies the shared
host tables first — `discord_event_claims`, `discord_jobs`, `discord_usage`,
`discord_payload_access`, `discord_job_replays`, from agent-runtimes'
`hostSchemaSql("discord")` — then `migrations/`, every time; each statement
is idempotent.

Dead jobs: `DATALAYER_OPERATOR=<your name> node dist/dead-letters.js list |
replay <id> | payload <id> <reason>`. `list` shows metadata and a hash of each
payload, never its words; every replay and payload read is kept with its
operator (`discord_job_replays`, `discord_payload_access`) and the database
role that did it (`database_role`).

### Database roles (DC-403)

By default the service's role (`discord`, the owner CNPG creates) owns every
table and runs the migrations, so it can read a dead job's payload. The split
takes that away:

- `discord_owner` owns the tables and functions and runs the migrations,
  then `migrations/roles/` (`node dist/migrate.js --roles`, with
  `DATALAYER_DISCORD_SERVICE_ROLE=discord`).
- The service's role keeps its tables and reaches the queue through the view
  `discord.discord_jobs`, which has no dead job (the default `search_path`,
  `"$user", public`, finds it first); it may not read `public.discord_jobs` or
  the audit. It still drops spent tokens and forgets a person's dead requests
  through `discord_drop_spent_tokens` and `discord_forget_jobs`, functions of
  the owner (migration 008).
- `discord_dead_letters` reads dead jobs only (`discord_dead_letters.discord_jobs`),
  replays them, and appends the audit, which it may not read or change. The
  dead-letters bin refuses the service's role.

On r1, once:

1. Create the two roles' Secrets in `datalayer-api`, of type
   `kubernetes.io/basic-auth`, each with the keys `username` and `password`
   (a password of URL-safe characters, such as `openssl rand -hex 32`):
   `datalayer-discord-db-owner` (`username: discord_owner`) and
   `datalayer-discord-db-dead-letters` (`username: discord_dead_letters`).
2. Deploy with `DATALAYER_DISCORD_DATABASE_ROLES=create`: the image with
   migration 008, still migrated as `discord`; CNPG creates the two login
   roles from the Secrets (`discord.databaseRoles.create`).
3. As a superuser, in the `discord` database (for instance
   `kubectl exec -i -n datalayer-api datalayer-discord-postgresql-1 -c postgres -- psql -v ON_ERROR_STOP=1 -d discord`
   on the primary), move the tables and functions to `discord_owner`. The
   service keeps running: its role is granted the tables back until the
   next step takes the queue's and the audit's away.

<!-- one-time-owner-sql -->

```sql
BEGIN;
CREATE SCHEMA IF NOT EXISTS discord AUTHORIZATION discord_owner;
CREATE SCHEMA IF NOT EXISTS discord_dead_letters AUTHORIZATION discord_owner;
GRANT CREATE ON SCHEMA public TO discord_owner;
ALTER TABLE discord_event_claims OWNER TO discord_owner;
ALTER TABLE discord_jobs OWNER TO discord_owner;
ALTER TABLE discord_usage OWNER TO discord_owner;
ALTER TABLE discord_payload_access OWNER TO discord_owner;
ALTER TABLE discord_job_replays OWNER TO discord_owner;
ALTER TABLE discord_installation OWNER TO discord_owner;
ALTER TABLE discord_user_link OWNER TO discord_owner;
ALTER TABLE discord_oauth_state OWNER TO discord_owner;
ALTER TABLE discord_thread_binding OWNER TO discord_owner;
ALTER TABLE discord_turn OWNER TO discord_owner;
ALTER TABLE discord_component OWNER TO discord_owner;
ALTER TABLE discord_allowance OWNER TO discord_owner;
ALTER TABLE discord_gateway_session OWNER TO discord_owner;
ALTER TABLE discord_direct_choice OWNER TO discord_owner;
ALTER FUNCTION discord_drop_spent_tokens(bigint) OWNER TO discord_owner;
ALTER FUNCTION discord_forget_jobs(text, text) OWNER TO discord_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO discord;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO discord;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO discord;
COMMIT;
```

<!-- /one-time-owner-sql -->

4. Deploy with `DATALAYER_DISCORD_DATABASE_ROLES=enforce`
   (`discord.databaseRoles.enforce`): the migrate job runs as `discord_owner`
   with `--roles`, which refuses to run while any `discord_` table or
   function, or either schema, is not `discord_owner`'s, and names it. The
   `datalayer-discord-dead-letters` Deployment (no replica) holds the
   reader's `DATABASE_URL`: scale it to one, then
   `kubectl exec -n datalayer-api deploy/datalayer-discord-dead-letters -- env DATALAYER_OPERATOR=<your name> node dist/dead-letters.js list`,
   and back to zero.

Who may run the bin is who may exec into that Deployment (Kubernetes RBAC,
recorded in the API server's audit log); the name it keeps is the one
`DATALAYER_OPERATOR` gives.

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
only (`--omit=dev`: agent-runtimes is an optional peer, which npm never installs, while the peers of the dependencies — `undici` for Bolt — are kept), runs as a non-root user and starts
`node dist/index.js`.
