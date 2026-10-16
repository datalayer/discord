import {
  Logger,
  pseudonym,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import { LOG_SALT, traceAttributes } from "../src/observability.js";

// Built so that no secret scanner's Discord rule matches it.
const BOT_TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4OQ", "GaBcDe", "x".repeat(30)].join(
  ".",
);

describe("redacted logs and pseudonymous traces (DC-008)", () => {
  it("never writes a Discord bot token or an interaction token", () => {
    const lines: string[] = [];
    const logger = new Logger((line) => lines.push(line), undefined, LOG_SALT);
    const interactionToken =
      Buffer.from("interaction:123456").toString("base64");
    logger.info("interaction.received", {
      interaction_token: interactionToken,
      note: `refused with ${BOT_TOKEN}`,
    });
    expect(lines[0]).not.toContain(BOT_TOKEN);
    expect(lines[0]).not.toContain(interactionToken);
  });

  it("names a server and a channel by pseudonym only", () => {
    const attributes = traceAttributes({
      applicationId: "123456789012345678",
      channelId: "223456789012345678",
      guildId: "323456789012345678",
    });
    expect(attributes).toEqual({
      "datalayer.discord.channel": pseudonym("223456789012345678", LOG_SALT),
      "datalayer.discord.installation": pseudonym(
        "123456789012345678:323456789012345678",
        LOG_SALT,
      ),
    });
    expect(JSON.stringify(attributes)).not.toContain("223456789012345678");
  });
});
