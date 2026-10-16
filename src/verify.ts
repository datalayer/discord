import { timestampWithinWindow } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { verifyKey } from "discord-interactions";
import type { IncomingMessage } from "node:http";

/**
 * Discord's signed requests: the raw body
 * kept, Ed25519 over `X-Signature-Timestamp + rawBody` with the
 * application's public key (`discord-interactions`, Discord's own), and the
 * timestamp within the shared five-minute window either way. Discord sends
 * invalid signatures on purpose and removes an endpoint that accepts them:
 * every failure is a 401.
 */

/** The most a signed request may carry; Discord's interactions are far smaller. */
export const BODY_LIMIT = 256 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("The request is too large.");
  }
}

/** The request's raw body, refused past `BODY_LIMIT`. */
export async function rawBodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Whether a request is Discord's, signed now: the signature and the window. */
export async function signedByDiscord(
  request: IncomingMessage,
  rawBody: Buffer,
  publicKey: string,
  nowSeconds: number,
): Promise<boolean> {
  const signature = header(request, "x-signature-ed25519");
  const timestamp = header(request, "x-signature-timestamp");
  if (!signature || !timestamp) return false;
  if (!/^[0-9a-f]{128}$/i.test(signature)) return false;
  if (!timestampWithinWindow(timestamp, nowSeconds)) return false;
  try {
    return await verifyKey(rawBody, signature, timestamp, publicKey);
  } catch {
    return false;
  }
}
