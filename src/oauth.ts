import {
  DELIVERY_PATH,
  HostRefusedError,
  type DatalayerHostClient,
  type EncryptedSecret,
  type Logger,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DiscordPort } from "./discord-port.js";
import { externalIdOf } from "./domain.js";
import { permissionsInteger } from "./permissions.js";
import type { DiscordStore } from "./store.js";

/**
 * Install and bind (DC-103). The Ship card sends
 * its owner to `/discord/install?datalayer_bind=<one-use code>`; the service
 * keeps the code, encrypted, under a one-use nonce and sends the browser to
 * Discord's bot authorization (guild install, the code grant required);
 * `/discord/oauth/callback` checks the signed state, spends the nonce,
 * exchanges Discord's code, reads the guild from the token response (the
 * redirect's `guild_id` is only a hint, refused when it differs), binds the
 * installation at Datalayer with the kept code and stores the host key
 * encrypted. A spent or expired bind code stores nothing.
 */

export const INSTALL_PATH = "/discord/install";
export const CALLBACK_PATH = "/discord/oauth/callback";
/** How long an install may take between the Ship card and Discord's answer. */
export const STATE_TTL_MS = 10 * 60 * 1000;
const BIND_PARAMETER = "datalayer_bind";

export type OAuthDependencies = Readonly<{
  applicationId: string;
  appUrl: string;
  webUrl: string;
  clientSecret: string;
  development: boolean;
  store: DiscordStore;
  cipher: SecretCipher;
  port: Pick<DiscordPort, "authorize">;
  hosts: Pick<DatalayerHostClient, "bind" | "self" | "setWebhook">;
  logger: Logger;
  now?: () => number;
}>;

const ESCAPES: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (one) => ESCAPES[one] ?? one);
}

function page(
  response: ServerResponse,
  status: number,
  title: string,
  words: string,
  webUrl: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(words)}</p><p><a href="${escapeHtml(webUrl.replace(/\/+$/, ""))}/docs/discord">Read the guide</a></p></body></html>`,
  );
}

/** The state Discord hands back: the nonce and its signature. */
export function signState(nonce: string, secret: string): string {
  const mac = createHmac("sha256", secret)
    .update(`discord-install:${nonce}`)
    .digest("base64url");
  return `${nonce}.${mac}`;
}

/** The nonce of a state this service signed, or `undefined`. */
export function nonceOf(state: string, secret: string): string | undefined {
  const [nonce, mac, ...rest] = state.split(".");
  if (!nonce || !mac || rest.length) return undefined;
  const expected = Buffer.from(signState(nonce, secret).split(".")[1]!);
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? nonce
    : undefined;
}

/** Discord's bot authorization URL for one install. */
export function authorizeUrl(
  dependencies: Pick<OAuthDependencies, "applicationId" | "appUrl">,
  state: string,
): string {
  const query = new URLSearchParams({
    client_id: dependencies.applicationId,
    integration_type: "0",
    permissions: permissionsInteger(),
    redirect_uri: `${dependencies.appUrl.replace(/\/+$/, "")}${CALLBACK_PATH}`,
    response_type: "code",
    scope: "bot applications.commands",
    state,
  });
  return `https://discord.com/oauth2/authorize?${query.toString()}`;
}

const FAILED =
  "The install did not finish: its code from Datalayer was used or expired (ten minutes), or Discord did not confirm it. Add @Datalayer again from the application's Ship tab in Datalayer.";

export function oauthRoutes(dependencies: OAuthDependencies) {
  const now = dependencies.now ?? Date.now;
  const fail = (response: ServerResponse, status = 400, words = FAILED) =>
    page(
      response,
      status,
      "@Datalayer was not added",
      words,
      dependencies.webUrl,
    );

  const install = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://service");
    const bindCode = url.searchParams.get(BIND_PARAMETER);
    if (!bindCode || !/^[A-Za-z0-9_-]{8,200}$/.test(bindCode))
      return fail(
        response,
        400,
        "Add @Datalayer to a server from the application's Ship tab in Datalayer: the install starts there.",
      );
    const nonce = randomBytes(24).toString("base64url");
    await dependencies.store.saveState(
      nonce,
      dependencies.cipher.encrypt(bindCode, `install:${nonce}`),
      new Date(now() + STATE_TTL_MS),
    );
    response.writeHead(302, {
      "cache-control": "no-store",
      location: authorizeUrl(
        dependencies,
        signState(nonce, dependencies.clientSecret),
      ),
    });
    response.end();
  };

  const callback = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://service");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const nonce = nonceOf(state, dependencies.clientSecret);
    if (!nonce) return fail(response);
    // Spent once, whatever happens next: a replayed state finds nothing.
    const kept = await dependencies.store.spendState(nonce, new Date(now()));
    if (!kept) return fail(response);
    if (!code) {
      // An install without a code (the code grant is required on the
      // portal) is refused outside development.
      return fail(
        response,
        400,
        dependencies.development
          ? "Discord sent no code: switch on Requires OAuth2 Code Grant on the application's Bot page."
          : FAILED,
      );
    }
    let authorization;
    try {
      authorization = await dependencies.port.authorize(
        code,
        `${dependencies.appUrl.replace(/\/+$/, "")}${CALLBACK_PATH}`,
      );
    } catch (error) {
      dependencies.logger.warn("install.authorize_failed", { error });
      return fail(response);
    }
    const guild = authorization.guild;
    const hint = url.searchParams.get("guild_id");
    if (
      !guild ||
      !/^\d{17,20}$/.test(guild.id) ||
      (hint && hint !== guild.id)
    ) {
      dependencies.logger.warn("install.guild_mismatch", {
        hinted: Boolean(hint),
      });
      return fail(response);
    }
    const externalId = externalIdOf(dependencies.applicationId, guild.id);
    try {
      const bound = await dependencies.hosts.bind({
        code: dependencies.cipher.decrypt(kept, `install:${nonce}`),
        externalId,
        name: guild.name ?? "",
      });
      const self = await dependencies.hosts.self(bound.hostKey);
      // Where Datalayer pushes this server's deliveries (DC-301), and the
      // secret they are signed with, kept encrypted. Refused or unreachable,
      // the worker reads the outbox instead.
      let deliverySecret: EncryptedSecret | undefined;
      try {
        const { signingSecret } = await dependencies.hosts.setWebhook(
          bound.hostKey,
          `${dependencies.appUrl.replace(/\/+$/, "")}${DELIVERY_PATH}/${encodeURIComponent(bound.hostUid)}`,
        );
        deliverySecret = dependencies.cipher.encrypt(
          signingSecret,
          `delivery:${externalId}`,
        );
      } catch (error) {
        dependencies.logger.warn("install.delivery_not_registered", { error });
      }
      await dependencies.store.saveInstallation({
        applicationId: dependencies.applicationId,
        guildId: guild.id,
        hostKey: dependencies.cipher.encrypt(bound.hostKey, externalId),
        hostUid: bound.hostUid,
        installedBy: self.accountUid,
        organizationUid: self.accountUid,
        permissions: authorization.permissions ?? permissionsInteger(),
        state: "active",
        ...(deliverySecret ? { deliverySecret } : {}),
      });
    } catch (error) {
      if (error instanceof HostRefusedError) {
        dependencies.logger.warn("install.bind_refused", {
          status: error.status,
        });
        return fail(response);
      }
      throw error;
    }
    dependencies.logger.info("install.bound", { installation: externalId });
    page(
      response,
      200,
      "@Datalayer is added",
      `@Datalayer answers in ${guild.name ?? "your server"} as the application you added it for. Each person links their own Datalayer account with /datalayer link in Discord.`,
      dependencies.webUrl,
    );
  };

  return { callback, install };
}
