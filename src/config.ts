import { z } from "zod";

/**
 * The service's settings (DC-008), read once at start
 * and refused by name when one is missing or malformed: no default stands in
 * for a credential, an address or a key (fail fast).
 */

const secret = z.string().min(1);
const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, "a Discord id (17 to 20 digits)");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().int().positive().default(3000),
    /**
     * What this process does: `ingress` serves Discord's signed
     * requests and persists them, `worker` works the durable queue and reads
     * the outbox, `gateway` holds the one gateway connection (DC-201: the
     * replica holding the leader lock), `all` every one of them (one process:
     * development, tests). Production runs each apart.
     */
    DATALAYER_DISCORD_ROLE: z.enum(["all", "ingress", "worker", "gateway"]),
    /** The durable store; only development and tests may run without one. */
    DATABASE_URL: secret.optional(),
    DATALAYER_DISCORD_APPLICATION_ID: snowflake,
    /** The application's Ed25519 public key, hex: what every interaction is verified with. */
    DATALAYER_DISCORD_PUBLIC_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters"),
    DATALAYER_DISCORD_BOT_TOKEN: secret,
    DATALAYER_DISCORD_CLIENT_SECRET: secret,
    /** AES-256-GCM key for host keys and interaction tokens at rest, base64 of 32 bytes. */
    DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY: secret,
    DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY_VERSION: z.coerce
      .number()
      .int()
      .positive(),
    /** This service's public HTTPS origin: the install page, the OAuth callback, deliveries. */
    DATALAYER_DISCORD_APP_URL: z.url().startsWith("https://"),
    DATALAYER_API_URL: z.url().startsWith("https://"),
    DATALAYER_WEB_URL: z.url().startsWith("https://"),
    /** How often the outbox is read, in seconds; 0 reads it never. */
    DATALAYER_DELIVERY_POLL_SECONDS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(30),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.DATABASE_URL)
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "production keeps its work in PostgreSQL",
      });
    if (value.DATALAYER_DISCORD_ROLE !== "all" && !value.DATABASE_URL)
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: `the ${value.DATALAYER_DISCORD_ROLE} role shares its durable queue in PostgreSQL`,
      });
  });

export type Config = z.infer<typeof schema>;

/** Every setting's name, as the service reads it. */
export const SETTINGS = Object.keys(schema.shape) as readonly string[];

/** The configuration, or an error naming each missing or malformed setting. */
export function readConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  const parsed = schema.safeParse(environment);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map(
    (issue) =>
      `${issue.path.join(".") || "configuration"}: ${environment[String(issue.path[0])] === undefined && issue.code !== "custom" ? "missing" : issue.message}`,
  );
  throw new Error(
    `@Datalayer for Discord cannot start:\n${problems.join("\n")}`,
  );
}
