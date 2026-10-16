import { z } from "zod";

/**
 * The service's settings (plans/DISCORD.md §10, DC-008), read once at start
 * and refused by name when one is missing or malformed: no default stands in
 * for a credential, an address or a key (fail fast, §2 rule 13).
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
     * What this process does (§4, §10): `ingress` serves Discord's signed
     * requests and persists them, `worker` works the durable queue and reads
     * the outbox, `all` both (one process: development, tests). Production
     * runs two ingress replicas and the workers apart; the gateway role comes
     * with Phase 2 (DC-201).
     */
    DATALAYER_DISCORD_ROLE: z.enum(["all", "ingress", "worker"]),
    /** The durable store; only development and tests may run without one. */
    DATABASE_URL: secret.optional(),
    DISCORD_APPLICATION_ID: snowflake,
    /** The application's Ed25519 public key, hex: what every interaction is verified with. */
    DISCORD_PUBLIC_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters"),
    DISCORD_BOT_TOKEN: secret,
    DISCORD_CLIENT_SECRET: secret,
    /** AES-256-GCM key for host keys and interaction tokens at rest, base64 of 32 bytes. */
    DISCORD_TOKEN_ENCRYPTION_KEY: secret,
    DISCORD_TOKEN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive(),
    /** This service's public HTTPS origin: the install page, the OAuth callback, deliveries. */
    DISCORD_APP_URL: z.url().startsWith("https://"),
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
