[![Datalayer](https://images.datalayer.io/legacy/datalayer-25.svg)](https://datalayer.ai)

[![Become a Sponsor](https://img.shields.io/static/v1?label=Become%20a%20Sponsor&message=%E2%9D%A4&logo=GitHub&style=flat&color=1ABC9C)](https://github.com/sponsors/datalayer)

# ☰ 💬 @Datalayer for Discord

`@Datalayer` brings a Datalayer application into a Discord server: `/ask` in a channel or thread, the _Ask Datalayer_ message command, `/datalayer` for a person's link and thread, and `/datalayer-admin` for the server. Discord is a host of Datalayer's existing session and approval contracts (the shared host kit in agent-runtimes' `src/portable/hosts`); it is not a separate agent runtime.

The user and administrator documentation is at [datalayer.ai/docs/discord](https://datalayer.ai/docs/discord). The service's settings, roles, database and image are in [`docs/operations.md`](docs/operations.md); the decisions in [`docs/adr/`](docs/adr/). `discord:0.1.0` runs on r1 (the ingress and worker roles) at `https://discord-dev.datalayer.run` for `Datalayer Dev`; the pilot's host `https://discord.datalayer.run` has its certificate and waits on the pilot application (DC-501).

## Creating the Discord applications

There are two applications, both owned by a Discord **team**, never by a personal account (verification later asks for the team owner's identity):

| Application     | Used for                                                 | Public bot | Endpoints                              |
| --------------- | -------------------------------------------------------- | ---------- | -------------------------------------- |
| `Datalayer Dev` | Development, on r1 (`https://discord-dev.datalayer.run`) | off        | `https://discord-dev.datalayer.run`    |
| `Datalayer`     | The r1 pilot, the service deployed beside Slack's        | on         | the service's host name on r1 (DC-501) |

Do the steps below once for each application. Keep every value you copy in a password manager until it reaches `.env` (development) or the Secret (r1); never paste one into an issue, a chat, a commit or the shell's history.

### 1. Make the team (once)

1. Turn on two-factor authentication on your Discord account (**User Settings → My Account → Enable Authenticator App**). Team administration and verification need it.
2. Open the [Developer Portal](https://discord.com/developers/applications), choose **Teams → New Team**, name it `Datalayer` and create it.
3. Invite the other developers (**Invite Member**, by Discord username), with the _Developer_ role for those who change settings and _Read-only_ for the others. Only the owner and admins see tokens and secrets.

### 2. Create the application

1. **Applications → New Application**.
2. Name: `Datalayer Dev` (development) or `Datalayer` (the pilot). **Team:** `Datalayer`. Accept the Developer Terms of Service and Developer Policy, then **Create**.

### 3. General Information

1. **App icon** (at least 512×512) and **Description**: _Ask your Datalayer applications from Discord._
2. Copy **Application ID** → `DATALAYER_DISCORD_APPLICATION_ID` and **Public Key** → `DATALAYER_DISCORD_PUBLIC_KEY` (64 hex characters). Neither is secret, but each belongs to its application.
3. **Terms of Service URL:** `https://datalayer.ai/terms`. **Privacy Policy URL:** `https://datalayer.ai/privacy`.
4. Leave **Interactions Endpoint URL** empty for now: Discord saves it only once the running service answers its PING (step 8).
5. **Save Changes**.

### 4. Installation

1. **Installation Contexts:** **Guild Install** only. Untick **User Install**.
2. **Install Link:** **None**. Discord refuses a default authorization link on a private application ("Private application cannot have a default authorization link"), and the application is added only from Datalayer's **Ship →** Discord card, which opens `<DATALAYER_DISCORD_APP_URL>/discord/install?datalayer_bind=…`; the service builds the authorize URL itself, with the bind code (step 10). `npm run commands:check` expects no install link (`custom_install_url` and `install_params` null).
3. **Save Changes**.

### 5. OAuth2

1. **Client Secret → Reset Secret**, confirm, and copy it → `DATALAYER_DISCORD_CLIENT_SECRET`. Discord shows it once; a reset ends the previous one.
2. **Redirects → Add Redirect:** `<DATALAYER_DISCORD_APP_URL>/discord/oauth/callback`, exactly (scheme, host and path). **Save Changes**.
3. Do not build a URL with the _OAuth2 URL Generator_: the service builds the install link itself (`bot applications.commands`, guild install, permissions `309237763136`, computed in `src/permissions.ts`).

### 6. Bot

1. **Username**: `Datalayer Dev` or `Datalayer`, and the same icon.
2. **Reset Token**, confirm, and copy it → `DATALAYER_DISCORD_BOT_TOKEN`. Discord shows it once; a reset ends the previous one.
3. **Public Bot:** off for `Datalayer Dev` (only the team adds it), on for `Datalayer` (any server owner adds it from the Ship tab).
4. **Requires OAuth2 Code Grant:** **on**, so every install passes through the service's callback, which binds the server to Datalayer.
5. **Privileged Gateway Intents:** all three **off** (_Presence_, _Server Members_, _Message Content_; ADR 0003).
6. **Save Changes**.

### 7. Run the service so Discord can reach it

Discord checks each endpoint by calling it, so the service must run first.

**Development**, from `datalayer-osp/src`:

```bash
cd tech/datalayer/discord
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

Keep the tunnel running and take its `https://…` origin as `DATALAYER_DISCORD_APP_URL` (a new origin at each restart: update steps 4, 5 and 8 when it changes). In a second terminal, create `.env` (ignored by Git), readable by you alone, with a fresh encryption key that is never printed:

```bash
cd tech/datalayer/discord
umask 077
printf 'DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" > .env
```

Then open `.env` in an editor and add the rest, pasting each value from the password manager (never `echo` one: it would stay in the shell's history):

```dotenv
NODE_ENV=development
PORT=3000
DATALAYER_DISCORD_ROLE=all
DATALAYER_DISCORD_APPLICATION_ID=
DATALAYER_DISCORD_PUBLIC_KEY=
DATALAYER_DISCORD_BOT_TOKEN=
# The OAuth2 page's client secret (Reset Secret shows it once).
DATALAYER_DISCORD_CLIENT_SECRET=
DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY_VERSION=1
DATALAYER_DISCORD_APP_URL=https://<your tunnel>
DATALAYER_API_URL=https://r1.datalayer.run
DATALAYER_WEB_URL=https://datalayer.ai
```

Without `DATABASE_URL` development keeps everything in memory (a restart forgets installs and links); set it to a local PostgreSQL and run `npm run migrate` to keep them. Then start the service:

```bash
npm run dev
curl --fail https://<your tunnel>/healthz
```

In the monorepo, agent-runtimes' `watch:lib` serves `lib/portable`; in a standalone clone, run `npm install` then `npm run fetch:agent-runtimes` first. The service refuses to start and names each missing or malformed setting.

**The r1 pilot:** put the four values in the r1 Secret `datalayer-discord-env` of the `datalayer-api` namespace, under the setting names (`DATALAYER_DISCORD_APPLICATION_ID`, `DATALAYER_DISCORD_PUBLIC_KEY`, `DATALAYER_DISCORD_BOT_TOKEN`, `DATALAYER_DISCORD_CLIENT_SECRET`), from a file that never enters Git and is removed after:

```bash
kubectl -n datalayer-api create secret generic datalayer-discord-env \
  --from-env-file=/path/to/discord-r1.env
shred -u /path/to/discord-r1.env
```

Then set `DATALAYER_DISCORD_ENABLED=true` in `~/.datalayer/datalayerrc-r1` and run the `p reup` the builder hands over with the chart (DC-501). Go on once `https://<host>/readyz` answers 200.

### 8. Enter the endpoints

Once the service answers on its host (`https://discord-dev.datalayer.run` for `Datalayer Dev`, `https://discord.datalayer.run` for the pilot; both run on r1 with Let's Encrypt certificates), open the application at [discord.com/developers/applications](https://discord.com/developers/applications) and fill these three fields, each followed by **Save Changes** (the green bar at the bottom):

| Left menu               | Field                                                                                | `Datalayer Dev`                                            | The pilot (`Datalayer`)                                |
| ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ |
| **General Information** | **Interactions Endpoint URL**                                                        | `https://discord-dev.datalayer.run/discord/interactions`   | `https://discord.datalayer.run/discord/interactions`   |
| **Webhooks**            | **Endpoint URL**, then switch **Events** on and tick **Application Authorized** only | `https://discord-dev.datalayer.run/discord/events`         | `https://discord.datalayer.run/discord/events`         |
| **OAuth2**              | **Redirects → Add Redirect**                                                         | `https://discord-dev.datalayer.run/discord/oauth/callback` | `https://discord.datalayer.run/discord/oauth/callback` |

- **Installation → Install Link** stays **None** (step 4): the install link is the service's `/discord/install`, opened from the Ship tab.
- Discord saves the **Interactions Endpoint URL** only when the service answers its test: a PING it must answer, and a request with a bad signature it must refuse. If saving fails, the service is not running or its `DATALAYER_DISCORD_PUBLIC_KEY` is not this application's.
- Discord also tests the **Webhooks** endpoint when events are switched on. _Application Deauthorized_ stays unticked: it names no server.
- On the **Bot** page, check two switches: **Requires OAuth2 Code Grant** on (every install passes through `/discord/oauth/callback` and is bound to a Datalayer organization), and **Public Bot** off for `Datalayer Dev` (on for the pilot only when other servers may install it).

Check what Discord saved, from the bot token (it prints the settings, never the token):

```bash
curl -sS -H "Authorization: Bot ${DATALAYER_DISCORD_BOT_TOKEN}" https://discord.com/api/v10/applications/@me \
  | jq '{interactions_endpoint_url, event_webhooks_url, event_webhooks_status, event_webhooks_types, redirect_uris, custom_install_url, bot_require_code_grant, bot_public, integration_types_config}'
```

Expected: the three URLs above, `custom_install_url: null` (no install link), `event_webhooks_status: 2` (enabled) with `["APPLICATION_AUTHORIZED"]`, `bot_require_code_grant: true`, `bot_public: false` for `Datalayer Dev`, and `integration_types_config` with key `"0"` only (guild install). The webhook events can also be switched on from the bot token, if the portal toggle was missed:

```bash
curl -sS -X PATCH -H "Authorization: Bot ${DATALAYER_DISCORD_BOT_TOKEN}" -H 'content-type: application/json' \
  https://discord.com/api/v10/applications/@me -d '{"event_webhooks_status":2,"event_webhooks_types":["APPLICATION_AUTHORIZED"]}'
```

### 9. Register the commands

The commands are defined in [`commands/commands.json`](commands/commands.json) and registered with one bulk overwrite (never one create per command). Turn on **User Settings → Advanced → Developer Mode** in Discord, right-click the test server and **Copy Server ID**, then:

```bash
set -a; . ./.env; set +a
npm run commands:schema                                # offline: within Discord's limits
npm run commands:register -- --guild <server id>       # development: one server, at once
npm run commands:check -- --guild <server id>          # what Discord has equals the file
```

Server commands appear at once but not in direct messages. For the pilot, register globally (no `--guild`) and check with `npm run commands:check -- --public-bot` (when its Public Bot is on). The check also compares the application's settings of step 8 with [`commands/application.json`](commands/application.json) (`{origin}` is `DATALAYER_DISCORD_APP_URL`) and names each one Discord holds differently, such as the Bot page's two switches. The script reads `DATALAYER_DISCORD_APPLICATION_ID`, `DATALAYER_DISCORD_BOT_TOKEN` and `DATALAYER_DISCORD_APP_URL` and prints neither secret.

### 10. Add @Datalayer to a server and try it

1. An install starts in Datalayer, never from the portal: open the application in the Studio, **Ship →** the Discord card **→ Add @Datalayer to a server**. It sets up a host installation and opens `<DATALAYER_DISCORD_APP_URL>/discord/install?datalayer_bind=…`, good once, for ten minutes. While the service is unpublished the card offers no link (`DATALAYER_DISCORD_APP_URL = ''` in the landing's `src/views/studio/apps/appDiscordSurface.ts`): for development, set it to your tunnel origin in a local landing, and never commit that.
2. Discord's authorization page lists the permissions; pick the test server and **Authorize**. The callback binds the server at Datalayer and keeps its host key encrypted. A page saying the install did not finish means the code was spent or expired: start again from the Ship tab.
3. In the server, run `/datalayer link`, open the link it answers (only you see it), sign in to Datalayer and choose **Link**.
4. `/datalayer status` shows the connection, your link and the application. Then `/ask question: Summarize the launch risks` in a channel: the answer comes in a thread started from it.
5. A second member account, unlinked, should be told privately to link first.

User and administrator documentation is published at [datalayer.ai/docs/discord](https://datalayer.ai/docs/discord).

### When something does not work

| Symptom                                         | Check                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The portal will not save the interactions URL   | The service runs, `/healthz` answers through the tunnel, and `DATALAYER_DISCORD_PUBLIC_KEY` is this application's.                                |
| _Discord sent no code_ after authorizing        | **Bot → Requires OAuth2 Code Grant** is off: switch it on.                                                                                        |
| _Invalid OAuth2 redirect_uri_ on Discord's page | **OAuth2 → Redirects** must be `<DATALAYER_DISCORD_APP_URL>/discord/oauth/callback` exactly, with the same origin as `DATALAYER_DISCORD_APP_URL`. |
| The install page refuses                        | Start from the Ship tab: its code works once, for ten minutes.                                                                                    |
| The commands do not appear                      | Registered with `--guild` for that server? `npm run commands:check -- --guild <id>`; server commands never reach direct messages.                 |
| `/ask` says a permission is missing             | A channel override denies one of the permissions of `src/permissions.ts` to the bot; the answer names it.                                         |
| Everything is forgotten after a restart         | Development without `DATABASE_URL` keeps memory only: set it and run `npm run migrate`.                                                           |
| The service will not start                      | Its first line names each missing or malformed setting ([`docs/operations.md`](docs/operations.md)).                                              |

## Checks

```bash
npm run check
```

Formatting, lint, type checking, the bundle-graph gate, the tests and the esbuild bundle; CI runs the same with PostgreSQL.
