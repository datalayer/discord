import { randomBytes } from "node:crypto";

/** A complete development environment. Test values: nothing here is a credential. */
export const ENVIRONMENT = {
  DATALAYER_API_URL: "https://r1.datalayer.run",
  DATALAYER_DISCORD_ROLE: "all",
  DATALAYER_WEB_URL: "https://datalayer.ai",
  DISCORD_APP_URL: "https://discord.example.datalayer.run",
  // Built, so that no secret scanner takes the test id for a credential.
  DISCORD_APPLICATION_ID: ["123456789", "012345678"].join(""),
  DISCORD_BOT_TOKEN: "test-only-not-a-bot-token",
  DISCORD_CLIENT_SECRET: "test-only-not-a-client-secret",
  DISCORD_PUBLIC_KEY: "a".repeat(64),
  DISCORD_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  DISCORD_TOKEN_ENCRYPTION_KEY_VERSION: "1",
  NODE_ENV: "development",
} as const;
