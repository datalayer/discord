import { z } from "zod";

/**
 * Every application command, one definition (`commands/commands.json`),
 * checked against Discord's limits before it is
 * registered: names, descriptions, option counts, guild install only
 * (`integration_types: [0]`), contexts guild and bot DM.
 */

const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;

const choice = z.object({
  name: z.string().min(1).max(100),
  value: z.string().min(1).max(100),
});

const option: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      name: z
        .string()
        .regex(NAME)
        .refine((name) => name === name.toLowerCase(), "lowercase"),
      description: z.string().min(1).max(100),
      type: z.number().int().min(1).max(11),
      required: z.boolean().optional(),
      autocomplete: z.boolean().optional(),
      min_length: z.number().int().min(0).max(6000).optional(),
      max_length: z.number().int().min(1).max(6000).optional(),
      choices: z.array(choice).max(25).optional(),
      options: z.array(option).max(25).optional(),
    })
    .strict(),
);

const common = {
  integration_types: z.tuple([z.literal(0)]),
  contexts: z.array(z.union([z.literal(0), z.literal(1)])).min(1),
  default_member_permissions: z.string().regex(/^\d+$/).optional(),
};

export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(1),
      name: z
        .string()
        .regex(NAME)
        .refine((name) => name === name.toLowerCase(), "lowercase"),
      description: z.string().min(1).max(100),
      options: z.array(option).max(25).optional(),
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal(3),
      name: z.string().min(1).max(32),
      ...common,
    })
    .strict(),
]);

export type CommandDefinition = z.infer<typeof commandSchema>;

/** The definitions, or an error naming each problem: at most 100 chat-input and 5 message commands. */
export function parseCommands(value: unknown): CommandDefinition[] {
  const commands = z.array(commandSchema).parse(value);
  const names = commands.map((one) => `${one.type}:${one.name}`);
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length)
    throw new Error(`A command is defined twice: ${repeated.join(", ")}`);
  if (commands.filter((one) => one.type === 1).length > 100)
    throw new Error("Discord takes at most 100 chat-input commands.");
  if (commands.filter((one) => one.type === 3).length > 5)
    throw new Error("Discord takes at most 5 message commands.");
  return commands;
}

/** What Discord answers of a registered command, reduced to what the definition says. */
export function definitionOf(registered: Record<string, unknown>): unknown {
  const keep = [
    "name",
    "type",
    "description",
    "options",
    "integration_types",
    "contexts",
    "default_member_permissions",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keep)
    if (
      registered[key] !== undefined &&
      registered[key] !== null &&
      registered[key] !== ""
    )
      out[key] = registered[key];
  // A message command's description is empty at Discord.
  if (out.type === 3) delete out.description;
  return out;
}

/** The differences between the definitions and what Discord has registered, by command. */
export function commandDrift(
  defined: readonly CommandDefinition[],
  registered: readonly Record<string, unknown>[],
): string[] {
  // Keys sorted; an option's `required: false` is the same as no `required`
  // (Discord leaves it out of what it answers).
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, one: unknown) =>
      one && typeof one === "object" && !Array.isArray(one)
        ? Object.fromEntries(
            Object.entries(one as Record<string, unknown>)
              .filter(
                ([key, field]) => !(key === "required" && field === false),
              )
              .sort(([a], [b]) => a.localeCompare(b)),
          )
        : one,
    );
  const drift: string[] = [];
  const live = new Map(
    registered.map((one) => [
      `${String(one.type)}:${String(one.name)}`,
      definitionOf(one),
    ]),
  );
  for (const command of defined) {
    const key = `${command.type}:${command.name}`;
    const found = live.get(key);
    if (!found) drift.push(`${command.name}: not registered`);
    else if (canonical(found) !== canonical(command))
      drift.push(`${command.name}: registered differently`);
    live.delete(key);
  }
  for (const key of live.keys())
    drift.push(`${key.split(":")[1]}: registered, not defined`);
  return drift;
}

/**
 * The application's settings as `commands/application.json` defines them
 * (`{origin}` is the service's public origin), and `GET /applications/@me`
 * answers them: the endpoints, the event types, the install link, guild
 * install only, the terms and privacy pages and the Bot page's two switches.
 */
export const applicationSchema = z
  .object({
    interactions_endpoint_url: z.string(),
    event_webhooks_url: z.string(),
    event_webhooks_status: z.literal(2),
    event_webhooks_types: z.array(z.string()).min(1),
    redirect_uris: z.array(z.string()).min(1),
    custom_install_url: z.string(),
    integration_types_config: z.record(z.string(), z.unknown()),
    terms_of_service_url: z.url(),
    privacy_policy_url: z.url(),
    bot_public: z.boolean(),
    bot_require_code_grant: z.boolean(),
  })
  .strict();

export type ApplicationSettings = z.infer<typeof applicationSchema>;

/** The definition for one application: `{origin}` replaced, and its Public Bot switch. */
export function applicationSettingsFor(
  value: unknown,
  origin: string,
  botPublic: boolean,
): ApplicationSettings {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search)
    throw new Error("The public origin is an https origin with no path.");
  const filled = JSON.parse(
    JSON.stringify(applicationSchema.parse(value)).replaceAll(
      "{origin}",
      url.origin,
    ),
  ) as unknown;
  return { ...applicationSchema.parse(filled), bot_public: botPublic };
}

/** Each setting Discord holds differently from the definition, with both values (none is a secret). */
export function applicationDrift(
  defined: ApplicationSettings,
  live: Record<string, unknown>,
): string[] {
  return Object.entries(defined)
    .filter(
      ([key, value]) => JSON.stringify(live[key]) !== JSON.stringify(value),
    )
    .map(
      ([key, value]) =>
        `${key}: ${JSON.stringify(live[key] ?? null)}, defined ${JSON.stringify(value)}`,
    );
}
