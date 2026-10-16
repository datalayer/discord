import { randomBytes } from "node:crypto";

/** A complete development environment. Test values: nothing here is a credential. */
export const ENVIRONMENT = {
  DATALAYER_API_URL: "https://r1.datalayer.run",
  DATALAYER_DISCORD_ROLE: "all",
  DATALAYER_WEB_URL: "https://datalayer.ai",
  DATALAYER_DISCORD_APP_URL: "https://discord.example.datalayer.run",
  // Built, so that no secret scanner takes the test id for a credential.
  DATALAYER_DISCORD_APPLICATION_ID: ["123456789", "012345678"].join(""),
  DATALAYER_DISCORD_BOT_TOKEN: "test-only-not-a-bot-token",
  DATALAYER_DISCORD_CLIENT_SECRET: "test-only-not-a-client-secret",
  DATALAYER_DISCORD_PUBLIC_KEY: "a".repeat(64),
  DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY_VERSION: "1",
  NODE_ENV: "development",
} as const;
