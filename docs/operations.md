# Operating @Datalayer for Discord

The service's settings, roles, health, Solr collection and image
(DC-008). It
refuses to start when a setting below is missing or malformed, and says which
one.

## Settings

| Setting                                          | Required                                                | What it is                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                       | yes                                                     | `development`, `test` or `production`.                                                                                                                                        |
| `PORT`                                           | no (3000)                                               | The HTTP port every role listens on.                                                                                                                                          |
| `DATALAYER_DISCORD_ROLE`                         | yes                                                     | `ingress` (Discord's signed requests, persisted), `worker` (the durable queue, the outbox), `gateway` (the one gateway connection) or `all` (every role: development, tests). |
| `DATALAYER_SOLR_URL`                             | in production, and for `ingress`, `worker` or `gateway` | Solr's base URL, ending in `/solr` (the platform's SolrCloud). Without it, development runs on memory.                                                                        |
| `DATALAYER_SOLR_USERNAME`                        | with `DATALAYER_SOLR_URL`                               | The Solr user the service authenticates as (basic auth).                                                                                                                      |
| `DATALAYER_SOLR_PASSWORD`                        | with `DATALAYER_SOLR_URL`                               | Its password. Kept in the Secret; never in a log, a metric or a trace.                                                                                                        |
| `DATALAYER_DISCORD_SOLR_COLLECTION`              | no (`discord`)                                          | The service's collection, made from the platform's configset.                                                                                                                 |
| `DATALAYER_DISCORD_APPLICATION_ID`               | yes                                                     | The Discord application's id (a snowflake).                                                                                                                                   |
| `DATALAYER_DISCORD_PUBLIC_KEY`                   | yes                                                     | Its Ed25519 public key, 64 hex characters: every interaction is verified with it.                                                                                             |
| `DATALAYER_DISCORD_BOT_TOKEN`                    | yes                                                     | The bot token. Kept in the `datalayer-discord-env` Secret and in memory only; never in Solr, a log, a metric or a trace.                                                      |
| `DATALAYER_DISCORD_CLIENT_SECRET`                | yes                                                     | The OAuth2 client secret, for the install's code exchange.                                                                                                                    |
| `DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY`         | yes                                                     | Base64 of 32 bytes: the AES-256-GCM key host keys and interaction tokens are encrypted with at rest.                                                                          |
| `DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY_VERSION` | yes                                                     | The key's version, kept beside every value it encrypted.                                                                                                                      |
| `DATALAYER_DISCORD_APP_URL`                      | yes                                                     | This service's public HTTPS origin: the install page, the OAuth callback and the delivery webhook live under it.                                                              |
| `DATALAYER_API_URL`                              | yes                                                     | Datalayer's API origin (HTTPS), where ai-agents' host routes answer (r1 for the pilot).                                                                                       |
| `DATALAYER_WEB_URL`                              | yes                                                     | Datalayer's web origin (HTTPS): `/hosts/link`, `/hosts/open`, `/docs/discord`.                                                                                                |
| `DATALAYER_DELIVERY_POLL_SECONDS`                | no (30)                                                 | How often a worker reads the outbox; 0 never.                                                                                                                                 |

`DATALAYER_DISCORD_LOG_SALT` (optional) salts the pseudonyms of logs and
spans; by default `datalayer-discord`.

## Delivery secrets

A server's delivery secret is kept encrypted with the key Datalayer derived
it under (`ai-agents-host-deliveries-v<N>`) and the registration's version
(both inside the installation's record); every push names that key (`X-Datalayer-Delivery-Key`)
and a push naming another, or none, is refused. A secret kept without a key
was derived from the platform's shared secret: its pushes are accepted until
31 December 2026, 00:00 UTC only. At start and every hour the service asks
Datalayer whether each server's webhook must be registered again
(`GET /apps/hosts/self` answers `delivery.renew`), registers it again at the
same address and keeps the new secret where the old one was (the kit's
`DeliveryRenewal`; a failure is logged as `delivery.not_renewed` and tried
again the next hour, the outbox carrying the deliveries meanwhile).

## Roles and health

Every role answers `GET /healthz` (the process answers) and `GET /readyz`
(its Solr collection answers a search; never Discord or Datalayer, so an outage of
either does not take the pods out of service). Anything else answers 404
until its box lands (`/discord/interactions`, DC-102; the install pages and
events, DC-103; deliveries, DC-301).

The `gateway` role (DC-201) holds the application's one connection to
Discord's gateway. Every replica tries to take a 30-second lease in the
Solr collection (`type_s:leader`, keyed `discord-gateway:<application id>`);
the one that takes it connects, the others try again every 15 seconds. The
leader renews its lease every 10 seconds: a renewal that fails (Solr
unreachable, or the lease taken after it ran out) closes the connection at
once. A lease, not a lock bound to a connection as PostgreSQL's advisory
lock was: a leader that dies stops renewing and another replica takes over
once its lease runs out (30 seconds at most); a leader cut off from Solr
stops at its next check (10 seconds at most), before its lease runs out, so
two replicas hold a session together only if a leader's checks stall for
the whole lease. It
identifies with GUILDS, GUILD_MESSAGES and DIRECT_MESSAGES only (no
privileged intent), spends identifies within `GET /gateway/bot`'s budget,
heartbeats and resumes, and queues each mention of the bot, direct message
and reply to its messages once by message id (`message:<id>`); the worker
answers them. Logs: `gateway.leading`, `gateway.ready`, `gateway.resumed`,
`gateway.lock_lost`, `gateway.closed`. It needs Node 22 (its `WebSocket`).

## The Solr collection

Everything the service keeps is a document of its one Solr collection
(`discord` by default), made from the platform's configset: Solr makes each
document's `id`, the service mints its `uid` (a ULID). `type_s` is the kind,
`key_s` its natural key, `record_stored` the object whole (stored, never
indexed: the host key, delivery secret, custom bot token and bind code stay
encrypted inside it, as they were), `creation_ts_dt` and
`last_update_ts_dt`, and the fields searched on beside it:

| Kind (`type_s`)                | `key_s`                                                                   | Searched on                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `installation`                 | `<application id>:<guild id>`                                             | `application_id_s`, `guild_id_s`, `host_uid_s` (one installation per host uid), `state_s`                 |
| `custom_app`                   | `<application id>`                                                        | `created_at_dt`                                                                                           |
| `user_link`                    | `<application id>:<guild id>:<user id>`                                   | `application_id_s`, `guild_id_s`, `user_id_s`                                                             |
| `direct_choice`                | `<application id>:<user id>`                                              | `application_id_s`, `guild_id_s`, `user_id_s`                                                             |
| `thread`                       | the thread key                                                            | `application_id_s`, `guild_id_s`, `opened_by_s`                                                           |
| `turn`                         | the thread key                                                            | (none: read by its key)                                                                                   |
| `component`                    | the render id                                                             | `application_id_s`, `guild_id_s`, `owner_id_s`, `kind_s`, `answered_by_s`, `approval_id_s`, `author_id_s` |
| `allowance`                    | `<application id>:<guild id>`                                             | `application_id_s`, `guild_id_s`                                                                          |
| `oauth_state`                  | the state nonce                                                           | `expires_dt`                                                                                              |
| `gateway_session`              | `<application id>`                                                        | (none)                                                                                                    |
| `leader`                       | `discord-gateway:<application id>`                                        | `holder_s`, `until_dt`                                                                                    |
| `claim`                        | `ingress:<idempotency key>`, or the event id a delivery or a press claims | (none)                                                                                                    |
| `usage`                        | `<hour>` and the quota key                                                | `usage_key_s`, `usage_window_s`, `used_i`                                                                 |
| `job`                          | none (one per job, by its uid)                                            | `state_s`, `available_dt`, `locked_dt`, `attempts_i`, `kind_s`                                            |
| `job_replay`, `payload_access` | none (the audit)                                                          | `job_uid_s`, `operator_s`                                                                                 |
| `lock`                         | none (one per stripe)                                                     | `stripe_i`, `holder_s`, `until_l`                                                                         |

Solr's only unique field is `id`, which it makes, so a natural key is kept
unique by a lock: every write of a keyed record runs under one of 32
striped lock documents (`type_s:lock`), taken with optimistic concurrency on
its `_version_` and held for a 15-second lease, made once at the service's
first start. Under it a write reads the key's document and writes it back,
committed softly: an insert-if-absent (a component, an event claim), a
conditional update (a turn claimed when free or run out, a component
answered once, a state spent once) and a counter are as safe as they were in
PostgreSQL. The queue's jobs are claimed with optimistic concurrency on
their `_version_` (two workers never both win one), their lease renewed every
minute, retried with backoff, dead after five attempts and taken back when
their worker stopped renewing for five minutes. There is no migration: the
collection and its configset are made by the platform's Solr setup.

Dead jobs: `DATALAYER_OPERATOR=<your name> node dist/dead-letters.js list |
replay <id> | payload <id> <reason…>`, run in a service pod (it reads the
service's settings): a job's id is its uid; a payload is a dead job's only,
read with a reason of ten characters at least, its credentials redacted;
every replay and payload read is kept (`job_replay`, `payload_access`, with
the operator's name) and audited in the logs.

The database roles of DC-403 (S-405's own role for the dead letters, the
service's role that could not read a dead job's payload) went with
PostgreSQL: a Solr user reaches the whole collection, and who may run the
bin is who may exec into a service pod (Kubernetes RBAC, recorded in the API
server's audit log); the name it keeps is the one `DATALAYER_OPERATOR`
gives.

## What runs, and the image

The service runs as one esbuild bundle (`npm run bundle`: `dist/index.js` and
`dist/dead-letters.js`) of its sources and agent-runtimes'
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
