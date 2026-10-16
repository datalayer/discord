[![Datalayer](https://images.datalayer.io/legacy/datalayer-25.svg)](https://datalayer.ai)

[![Become a Sponsor](https://img.shields.io/static/v1?label=Become%20a%20Sponsor&message=%E2%9D%A4&logo=GitHub&style=flat&color=1ABC9C)](https://github.com/sponsors/datalayer)

# ☰ 💬 @Datalayer for Discord

The @Datalayer Discord application: people ask Datalayer agents and deployed applications with `/ask`, a message's *Ask Datalayer* menu, and (Phase 2) mentions, and get the answer in the thread. A TypeScript service over Discord's HTTP interactions endpoint, built on the host contracts of Datalayer's ai-agents service and the shared host code of `@datalayer/agent-runtimes/lib/portable/hosts`. The plan is [`plans/DISCORD.md`](https://github.com/datalayer/ui/blob/main/plans/DISCORD.md) in the landing repository.

## Create the Discord application, step by step

Discord has no API to create an application: these steps are done by a person in the [Developer Portal](https://discord.com/developers/applications). Do them once for **development** (`Datalayer Dev`) and later once for the **r1 pilot** (`Datalayer`). Nothing here is committed or printed; the values go to `~/.datalayer/datalayerrc-prod1` (step 9), from which the service's chart writes the r1 Secret.

### 1. A Datalayer developer team

Create the application under a **team**, never a personal account: Discord's verification (needed at 100 servers) asks for the team owner's identity.

1. In the [Developer Portal](https://discord.com/developers/teams), open **Teams → New Team**, name it `Datalayer`, and create it (skip if it exists).
2. Invite the other developers from the team page (**Invite Member**), as *Developer* or *Read-only*.

### 2. The application

1. **Applications → New Application**.
2. Name it `Datalayer Dev` (development) or `Datalayer` (r1 pilot), choose **Team: Datalayer**, accept the Developer Terms and Policy, **Create**.
3. On **General Information**:
   - upload the Datalayer icon (1024×1024 PNG) and write the description: *Ask Datalayer agents and applications from Discord.*;
   - set **Terms of Service URL** and **Privacy Policy URL** to Datalayer's public terms and privacy pages (the same as the Slack app's);
   - copy the **Application ID** and the **Public Key** (step 9). Neither is secret, but they differ per application.

### 3. The bot

On the **Bot** page:

1. **Reset Token** → **Yes, do it!** → copy the token at once (it is shown once; step 9). Never paste it anywhere else.
2. **Public Bot**: off for `Datalayer Dev` (only the team installs it); on for the pilot later, when other servers may install it.
3. **Requires OAuth2 Code Grant**: **on**, so every install goes through the service's `/discord/oauth/callback` and is bound to a Datalayer organization.
4. **Privileged Gateway Intents**: leave **all three off** (Presence, Server Members, Message Content). The service reads only interactions and, in Phase 2, mentions and direct messages, which arrive without *Message Content* (ADR 0003).

### 4. Installation

On the **Installation** page:

1. **Installation Contexts**: check **Guild Install** only; uncheck **User Install**.
2. **Install Link**: choose **None** for now. Once the service runs (step 10) it becomes **Custom URL** → `https://<host>/discord/install`, which carries the bind state; a *Discord Provided Link* cannot.
3. Leave the default install settings empty: the service's install link asks for the scopes `bot applications.commands` and the permissions integer computed in `src/permissions.ts` (`VIEW_CHANNEL`, `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`, `CREATE_PUBLIC_THREADS`, `READ_MESSAGE_HISTORY`, `EMBED_LINKS`, `ATTACH_FILES`, `ADD_REACTIONS`; never administrator or manage permissions).

### 5. OAuth2

On the **OAuth2** page:

1. **Client Secret → Reset Secret** → copy it at once (step 9).
2. Add the redirect later (step 10): `https://<host>/discord/oauth/callback`.

### 6. A test server

1. In the Discord app, **+ (Add a Server) → Create My Own → For me and my friends**, name it `Datalayer Dev Test`.
2. Turn on **Developer Mode** (User Settings → Advanced), right-click the server → **Copy Server ID** (step 9).
3. Invite a **second account** (a colleague or a test account) to the server: the drills check that one person's link and approvals are never another's.

### 7. Who signs off

Before a real bot token is stored in the r1 Secret, the security and privacy owners sign off [`docs/threat-model.md`](docs/threat-model.md) (DC-003). The development application may be created before that; its token stays in the rc until then.

### 8. What not to switch on

- No privileged intent, no *Interactions Endpoint URL* until the service answers Discord's PING (Discord refuses to save a URL that does not answer), no *Linked Roles*, no *Rich Presence*, no *Activities*, no *App Directory* listing until verification (DC-505).

### 9. Store the values in the prod1 rc, without echo

Run this in a terminal (nothing is shown while you paste; it prints `saved` only when every value was entered):

```bash
read -rp  "Application ID: " APP; read -rp "Public Key: " PUB; read -rp "Test server ID: " GUILD
read -rsp "Bot token: " BOT; echo; read -rsp "Client secret: " SEC; echo
[ -n "$APP" ] && [ -n "$PUB" ] && [ -n "$GUILD" ] && [ -n "$BOT" ] && [ -n "$SEC" ] && cp ~/.datalayer/datalayerrc-prod1 ~/.datalayer/datalayerrc-prod1.bak-discord && printf '\nexport DATALAYER_DISCORD_DEVELOPMENT_APPLICATION_ID=%s\nexport DATALAYER_DISCORD_DEVELOPMENT_PUBLIC_KEY=%s\nexport DATALAYER_DISCORD_DEVELOPMENT_GUILD_ID=%s\nexport DATALAYER_DISCORD_DEVELOPMENT_BOT_TOKEN=%s\nexport DATALAYER_DISCORD_DEVELOPMENT_CLIENT_SECRET=%s\n' "$APP" "$PUB" "$GUILD" "$BOT" "$SEC" >> ~/.datalayer/datalayerrc-prod1 && echo saved
unset APP PUB GUILD BOT SEC
```

For the r1 pilot application, the same with `DATALAYER_DISCORD_PILOT_` in place of `DATALAYER_DISCORD_DEVELOPMENT_`.

### 10. After the service runs (the builder, then you)

1. The `datalayer-discord` chart creates its Secret `datalayer-discord-env` on r1 (generated keys kept across reups) and its Postgres; the application's values are written to that Secret from the rc, never printed (DC-501).
2. Once `https://<host>/readyz` answers 200, in the portal:
   - **General Information → Interactions Endpoint URL**: `https://<host>/discord/interactions` (Discord sends a PING; it saves only when the service answers);
   - **Webhooks → Endpoint URL**: `https://<host>/discord/events`, event **Application Authorized** only;
   - **OAuth2 → Redirects**: `https://<host>/discord/oauth/callback`;
   - **Installation → Install Link → Custom URL**: `https://<host>/discord/install`.
3. Register the commands: `npm run commands:register -- --env development --guild <test server id>` (guild commands appear at once in that server); `npm run commands:check` compares the live application with `commands/`.
4. Install the app into the test server from the Ship tab's Discord card (Studio → an application → Ship → Discord), link your account with `/datalayer link`, and `/ask` something.

For local development without a public host, the interactions endpoint can be a tunnel to this machine (DC-102); Discord saves it only while the tunnel answers.
