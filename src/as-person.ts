import {
  hostSessionOf,
  lastAnswer,
  type ApprovalPresentation,
  type DatalayerHostClient,
  type HostKeyCredentials,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * Datalayer as one Discord member: the
 * installation's host key exchanged for that member's fifteen-minute host
 * token on one deployment, then an approval read or decided, or a session's
 * last answer read, as them. A member who is not linked, or
 * not the one an approval waits on, is refused by Datalayer, never decided
 * for by the service. Tests give the worker and the deliveries a fake.
 */

/** Who acts: the installation's key, the Discord member, the deployment. */
export type Person = Readonly<{
  hostKey: string;
  userId: string;
  deploymentUid: string;
}>;

export interface AsPerson {
  /** How an approval is shown, read as the person (404 when it is not theirs). */
  presentation(
    person: Person,
    approvalId: string,
  ): Promise<ApprovalPresentation>;
  /** Decide an approval as the person, on the very presentation shown (its digest). */
  decide(
    person: Person,
    approvalId: string,
    decision: Readonly<{ approve: boolean; digest: string; note?: string }>,
  ): Promise<{ status: string }>;
  /** The session's last answer, read as the person: `undefined` when it has none. */
  lastAnswer(person: Person, sessionUid: string): Promise<string | undefined>;
}

/** `AsPerson` over ai-agents' host routes and the session API. */
export function httpAsPerson<P>(
  credentials: Pick<HostKeyCredentials<P>, "exchangeFor">,
  hosts: Pick<DatalayerHostClient, "presentation" | "decide">,
  fetchImplementation: typeof fetch = fetch,
): AsPerson {
  const tokenOf = async (person: Person) =>
    credentials.exchangeFor({
      deploymentUid: person.deploymentUid,
      externalUserId: person.userId,
      hostKey: person.hostKey,
    });
  return {
    decide: async (person, approvalId, decision) =>
      hosts.decide((await tokenOf(person)).access_token, approvalId, decision),
    lastAnswer: async (person, sessionUid) => {
      const host = hostSessionOf(await tokenOf(person));
      const text = await lastAnswer(fetchImplementation, host, sessionUid);
      if (text === null)
        throw new Error("Datalayer did not answer the session's messages.");
      return text;
    },
    presentation: async (person, approvalId) =>
      hosts.presentation((await tokenOf(person)).access_token, approvalId),
  };
}
