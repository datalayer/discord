# Threat model (draft)

Status: draft, 16 October 2026 (DC-003). It is signed off by
the user, as security and privacy owner, before a real bot token is stored in
the `datalayer-discord-env` Secret. Not signed off.

## Data flow

```text
Discord member ──(signed interaction, Ed25519)──► ingress /discord/interactions
                                                    │ verify · claim · persist (one transaction) · defer ≤3 s
                                                    ▼
                                    PostgreSQL discord_* (jobs, claims, encrypted tokens)
                                                    │
                                                    ▼
                    worker ──(host key + member id)──► ai-agents /apps/hosts/self/token ──► 15-min host token
                       │                                                                          │
                       │◄──────────────── AG-UI stream (session API, HTTPS, Datalayer's origin) ◄─┘
                       │
                       └──(interaction token ≤15 min, then bot token)──► Discord REST: @original edits, follow-ups, thread messages

ai-agents ──(signed delivery, HMAC)──► /datalayer/deliveries/{host} ──► queue ──► worker ──► Discord REST
Discord ──(signed webhook event)──► /discord/events (APPLICATION_AUTHORIZED) ──► 204, persisted
Owner ──(Ship card: one-use bind code)──► /discord/install ──► Discord OAuth2 (code grant) ──► callback ──► POST /apps/hosts/bind
```

What crosses into Datalayer: the invocation only (the command's options, the
mention's or DM's text, the message a context-menu command targets), the
member's id, the server, channel, thread and message ids. Nothing else of a
channel is read (ADR 0003).

## Retention

| Data                                                          | Where                                                                      | Kept                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Interaction token                                             | inside its job (`discord_jobs`), encrypted and bound to the interaction id | 15 minutes: dropped from queued and dead jobs every minute after (`dropSpentTokens`); a 404'd token never used again |
| Claims (interactions, messages, presses, deliveries)          | `discord_event_claims`, `discord_claim`                                    | 7 days                                                                                                               |
| Dead jobs                                                     | `discord_jobs` (`state = dead`)                                            | 14 days                                                                                                              |
| Delivery rows                                                 | `discord_delivery`                                                         | 30 days                                                                                                              |
| A removed server's installation, bindings, tokens, components | `discord_*`                                                                | 24 hours after removal, audited                                                                                      |
| A person's rows after `/datalayer forget`                     | `discord_*` naming their id                                                | deleted within 30 days                                                                                               |
| Host key                                                      | `discord_installation`, encrypted                                          | until removal                                                                                                        |
| Bot token, client secret                                      | the Secret and memory only                                                 | until rotated                                                                                                        |
| Session records                                               | Datalayer, not this service                                                | Datalayer's record retention                                                                                         |

## Threats

Each threat is mapped to the code and test that hold it, or named as a gap.
"Gap" means the box that closes it has not landed.

| #   | Threat                                        | Control                                                                                                                                                                                                                                                       | Code                                                                                                                                       | Test                                                                                                                                      | State             |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| T1  | Forged interaction or event                   | Ed25519 over `timestamp + raw body` with the application's public key; 401 otherwise                                                                                                                                                                          | `src/verify.ts`, `src/interactions.ts`, `src/events.ts`                                                                                    | `test/integration/interactions.test.ts`, `events.test.ts`                                                                                 | built             |
| T2  | Replayed request                              | Timestamp within `REQUEST_WINDOW_SECONDS` either way; claim by interaction id                                                                                                                                                                                 | hosts `timestampWithinWindow`; `src/verify.ts`; the claim by interaction id in the job's transaction                                       | `interactions.test.ts` (skewed both ways, a replay answered once)                                                                         | built             |
| T3  | Discord's invalid-signature probes            | Always 401, never a 2xx                                                                                                                                                                                                                                       | `src/verify.ts` (a bad signature, PING included, is 401)                                                                                   | `interactions.test.ts`                                                                                                                    | built             |
| T4  | OAuth CSRF and guild substitution             | Signed one-use `state`; the guild from the token response, not the `guild_id` hint; code grant required                                                                                                                                                       | `src/oauth.ts` (state signed and spent once, the bind code kept server-side, the guild from the token response)                            | `test/integration/oauth.test.ts`                                                                                                          | built             |
| T5  | Cross-tenant ids                              | Every lookup keyed by `(application, guild)`; the target validated against the installation                                                                                                                                                                   | DC-102, DC-301                                                                                                                             | DC-301                                                                                                                                    | gap               |
| T6  | Link takeover                                 | One-use link codes, confirmed at Datalayer while signed in; the service never trusts an id in a URL                                                                                                                                                           | ai-agents links; DC-104                                                                                                                    | `hostLink`, DC-104                                                                                                                        | server side built |
| T7  | Component replay or transplant across servers | `custom_id` names a `discord_component` row with its owner, installation and state; unknown kinds fail closed                                                                                                                                                 | `src/interactions.ts` `componentOf`; `src/worker.ts` (the row's kind, installation and owner checked); DC-207, DC-302                      | `interactions.test.ts`, `commands.test.ts` (another member's press refused)                                                               | partly built      |
| T8  | Approval confused deputy                      | Re-read as the presser with their own exchange; ownership, pending state and digest checked; Mail only                                                                                                                                                        | hosts `hostMayDecide`, `renderApproval`; DC-303                                                                                            | hosts `approvalRenderers.unit.test.ts`, `contracts.unit.test.ts`; DC-303                                                                  | partly built      |
| T9  | Ephemeral leakage                             | Private or refused after a public deferral: delete `@original`, follow up ephemerally; a public turn's running answer never shown (status and length only), the whole answer only once checked, its thread started only then; a private turn mapped `private` | `src/worker.ts` (`#privately`, `secretBearing`, `openThread`), `src/render.ts` (`progressBody(…, publicly)`), `src/domain.ts` (`targetOf`) | `test/integration/worker.test.ts` (a secret streamed in pieces: no public text, no thread; a private `/ask`)                              | built             |
| T10 | Prompt and file injection                     | Other people's words are provenance-marked input, never instructions; attachments scanned (ClamAV)                                                                                                                                                            | DC-105, DC-306                                                                                                                             | DC-306                                                                                                                                    | gap               |
| T11 | SSRF through attachment URLs                  | Fetch only Discord's CDN hosts, size-capped while streaming                                                                                                                                                                                                   | DC-306                                                                                                                                     | DC-306                                                                                                                                    | gap               |
| T12 | Gateway session hijack                        | The token in the Secret only; one leader under an advisory lock; resume only at `resume_gateway_url`                                                                                                                                                          | DC-201                                                                                                                                     | DC-201                                                                                                                                    | gap               |
| T13 | Queue duplication                             | Claim and job in one transaction; insert-first turn claim                                                                                                                                                                                                     | hosts `PostgresWorkQueue`                                                                                                                  | Slack's Postgres runs; DC-205                                                                                                             | partly built      |
| T14 | The 15-minute token boundary                  | Switch to the bot token at 14 minutes or on a 404, never reuse a 404'd token; a job past 15 minutes dropped unread; the token dropped from every job past its 15 minutes                                                                                      | `src/worker.ts` (`TOKEN_SWITCH_MS`, `TOKEN_LIFETIME_MS`, `DiscordError.tokenGone`), `src/postgres-store.ts` (`dropSpentTokens`)            | `worker.test.ts` (16-minute turn, a 404, a job past 15 minutes), `store.test.ts` (tokens dropped from queued and dead jobs on PostgreSQL) | built             |
| T15 | Removal races                                 | Late jobs of a removed installation dropped, never reviving it                                                                                                                                                                                                | `src/removal.ts`; the worker drops a removed server's jobs                                                                                 | `test/integration/removal.test.ts`, `worker.test.ts`                                                                                      | built             |
| T16 | Secrets in logs, metrics, traces              | `redact` by field and by shape (Discord bot tokens included), pseudonymous ids                                                                                                                                                                                | hosts `observability.ts`; `src/observability.ts`                                                                                           | hosts `observability.unit.test.ts`; `test/observability.test.ts`                                                                          | built             |
| T17 | Supply chain                                  | One esbuild bundle gated on its module graph; the externals' installed graph checked; exact versions; gitleaks and `npm audit --omit=dev` in CI                                                                                                               | `scripts/bundle.ts`, `scripts/check-installed.ts`, CI                                                                                      | `test/forbidden-graph.test.ts`                                                                                                            | built             |

## Discord's Developer Policy and Developer Terms

Read on 16 October 2026. The live address
(`support-dev.discord.com/hc/articles/8563934450327`, to which
`docs.discord.com/developers/policies-and-agreements/developer-policy`
redirects) answers 403 to a fetch; its indexed title is "Effective date: July
8, 2024". The text of that version was read from Discord's own docs
repository, `discord/discord-api-docs` at `df75014`
(`docs/policies_and_agreements/Developer_Policy.md` and
`Developer_Terms_of_Service.md`, the last version kept there before the
policies moved to the support site in March 2025). Re-read the live page in a
browser before verification (DC-505) in case a later version replaced it.

What it allows and requires of this service:

- **Model providers as processors: permitted, under conditions.** Terms §5:
  "You will not share API Data with any third party, except … (i) with a
  Service Provider". Terms §12(a): before using a Service Provider, require
  it "to first agree in writing to only access and use the APIs and API Data
  for you and at your direction … and for no other purpose (including their
  own)", and to delete all API Data when the service ends. A model provider
  that answers a turn is such a Service Provider: its contract must say no
  use for its own purposes (training included) and deletion at the end.
  Policy 17–18: no data brokers, advertising, sale or licensing.
- **No training.** Policy 21: "Do not use message content obtained through
  the APIs to train machine learning or AI models (including large language
  models) unless express permission is granted by Discord." This service
  trains nothing, and its providers may not (above).
- **Purpose.** Policy 15: API Data only for the stated functionality;
  improvement only from aggregated or de-identified data. Policy 16: no
  profiling, and no sensitive information except as the Terms allow.
- **Privacy policy.** Terms §5: a privacy policy that "clearly, accurately,
  and fully describes to users of your Application what data you collect,
  how you use and share such data with us and third parties, and how users
  can request deletion of such data", linked in the Developer Portal and
  reachable from the application (`/docs/discord` §6 and §10 link it).
- **Deletion.** Terms §5: delete API Data promptly when no longer necessary,
  when the application stops, when Discord or the user asks; "an easily
  accessible way to ask for their API Data to be modified and deleted"
  (`/datalayer forget`, DC-106, 30 days). Unauthorized access to
  API Data is notified to Discord and the users affected.
- **Credentials.** Terms §3: tokens and client secrets encrypted in any file
  a third party can reach; never embedded in open-source code (this
  repository is public: the Secret only, gitleaks in CI).
- **Users.** Policy 2 and 5: no process started on a person's behalf without
  their permission, no unsolicited direct messages (the bot writes to a DM
  only in answer to the person, or for a decision that waits on them); a way
  to report problems with the application (`/docs/discord` §10).

Left for the owner's sign-off: that Datalayer's model-provider agreements
carry the §12(a) terms, and the privacy policy's Discord paragraph.
