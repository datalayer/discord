# Threat model (draft)

Status: draft, 16 October 2026 (plans/DISCORD.md DC-003). It is signed off by
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

| Data                                                          | Where                                   | Kept                                   |
| ------------------------------------------------------------- | --------------------------------------- | -------------------------------------- |
| Interaction token                                             | `discord_interaction`, encrypted        | until it expires (15 minutes) or a 404 |
| Claims (interactions, messages, presses, deliveries)          | `discord_event_claims`, `discord_claim` | 7 days                                 |
| Dead jobs                                                     | `discord_jobs` (`state = dead`)         | 14 days                                |
| Delivery rows                                                 | `discord_delivery`                      | 30 days                                |
| A removed server's installation, bindings, tokens, components | `discord_*`                             | 24 hours after removal, audited        |
| A person's rows after `/datalayer forget`                     | `discord_*` naming their id             | deleted within 30 days                 |
| Host key                                                      | `discord_installation`, encrypted       | until removal                          |
| Bot token, client secret                                      | the Secret and memory only              | until rotated                          |
| Session records                                               | Datalayer, not this service             | Datalayer's record retention           |

## Threats

Each threat is mapped to the code and test that hold it, or named as a gap.
"Gap" means the box that closes it has not landed.

| #   | Threat                                        | Control                                                                                                                                         | Code                                                  | Test                                                                     | State             |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ----------------- |
| T1  | Forged interaction or event                   | Ed25519 over `timestamp + raw body` with the application's public key; 401 otherwise                                                            | `src/interactions.ts` (DC-102)                        | `test/integration/interactions.test.ts`                                  | gap               |
| T2  | Replayed request                              | Timestamp within `REQUEST_WINDOW_SECONDS` either way; claim by interaction id                                                                   | hosts `timestampWithinWindow`; claims                 | hosts `health.unit.test.ts`; DC-102                                      | partly built      |
| T3  | Discord's invalid-signature probes            | Always 401, never a 2xx                                                                                                                         | DC-102                                                | DC-102                                                                   | gap               |
| T4  | OAuth CSRF and guild substitution             | Signed one-use `state`; the guild from the token response, not the `guild_id` hint; code grant required                                         | `src/oauth.ts` (DC-103)                               | `test/integration/oauth.test.ts`                                         | gap               |
| T5  | Cross-tenant ids                              | Every lookup keyed by `(application, guild)`; the target validated against the installation                                                     | DC-102, DC-301                                        | DC-301                                                                   | gap               |
| T6  | Link takeover                                 | One-use link codes, confirmed at Datalayer while signed in; the service never trusts an id in a URL                                             | ai-agents links; DC-104                               | `hostLink`, DC-104                                                       | server side built |
| T7  | Component replay or transplant across servers | `custom_id` names a `discord_component` row with its owner, installation and state; unknown kinds fail closed                                   | DC-207, DC-302                                        | DC-207                                                                   | gap               |
| T8  | Approval confused deputy                      | Re-read as the presser with their own exchange; ownership, pending state and digest checked; Mail only                                          | hosts `hostMayDecide`, `renderApproval`; DC-303       | hosts `approvalRenderers.unit.test.ts`, `contracts.unit.test.ts`; DC-303 | partly built      |
| T9  | Ephemeral leakage                             | Private or refused after a public deferral: delete `@original`, follow up ephemerally                                                           | DC-105                                                | DC-105                                                                   | gap               |
| T10 | Prompt and file injection                     | Other people's words are provenance-marked input, never instructions; attachments scanned (ClamAV)                                              | DC-105, DC-306                                        | DC-306                                                                   | gap               |
| T11 | SSRF through attachment URLs                  | Fetch only Discord's CDN hosts, size-capped while streaming                                                                                     | DC-306                                                | DC-306                                                                   | gap               |
| T12 | Gateway session hijack                        | The token in the Secret only; one leader under an advisory lock; resume only at `resume_gateway_url`                                            | DC-201                                                | DC-201                                                                   | gap               |
| T13 | Queue duplication                             | Claim and job in one transaction; insert-first turn claim                                                                                       | hosts `PostgresWorkQueue`                             | Slack's Postgres runs; DC-205                                            | partly built      |
| T14 | The 15-minute token boundary                  | Switch to the bot token at 14 minutes or on a 404, never reuse a 404'd token                                                                    | DC-105                                                | DC-105                                                                   | gap               |
| T15 | Removal races                                 | Late jobs of a removed installation dropped, never reviving it                                                                                  | DC-107                                                | DC-107                                                                   | gap               |
| T16 | Secrets in logs, metrics, traces              | `redact` by field and by shape (Discord bot tokens included), pseudonymous ids                                                                  | hosts `observability.ts`; `src/observability.ts`      | hosts `observability.unit.test.ts`; `test/observability.test.ts`         | built             |
| T17 | Supply chain                                  | One esbuild bundle gated on its module graph; the externals' installed graph checked; exact versions; gitleaks and `npm audit --omit=dev` in CI | `scripts/bundle.ts`, `scripts/check-installed.ts`, CI | `test/forbidden-graph.test.ts`                                           | built             |

## Discord's Developer Policy

Not read: on 16 October 2026 the policy's address
(`support-dev.discord.com/hc/articles/8563934450327`, to which
`docs.discord.com/developers/policies-and-agreements/developer-policy`
redirects) answered 403 to a fetch. Before a real token is stored, read its
current text in a browser and record here: whether sending API data to the
model providers, as Datalayer's service processors, is permitted; what the
privacy policy must disclose; and the deletion obligations. Discord's public
safety page says that training on message content needs permission; this
service trains nothing on Discord content.
