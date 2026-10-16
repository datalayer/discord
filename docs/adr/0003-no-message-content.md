# ADR 0003: no MESSAGE_CONTENT

Status: accepted, 16 October 2026 (DC-002): proposed and
acknowledged by the user the same day.

## Decision

The application asks for no privileged intent. Without `MESSAGE_CONTENT`,
Discord gives an app the content of a message only when the message mentions
it, is a DM to it, replies (with ping on reply) to one of its regular
messages, or is the target of its message command. That is exactly what
@Datalayer reads; it reads no channel history and monitors nothing.

## Rejected

- **`MESSAGE_CONTENT`** to continue a thread without a mention: it would read
  every message of every channel the bot sees, requires a justification and
  review past 100 servers (and privileged-intent review at 10,000 reachable
  users), and makes Discord's words Datalayer's to protect for no product
  need. A thread continues by a mention or a ping-on reply, and the first
  answer says so.

## Consequences

A reply to an `/ask` answer (an interaction response), or a reply with the
ping turned off, does not reach Datalayer; the guide says so.
Turning on any privileged intent is the user's decision and a new ADR.
