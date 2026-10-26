import type { AdapterContext } from "@rakazo/adapter-kit";

export function selectRunConnections<
  T extends { connectorId: string; provider: string; status: string },
>(rows: T[], connectedComposioProviders: string[]): T[] {
  const liveProviders = new Set(
    connectedComposioProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );
  const connectedKeys = new Set(
    rows
      .filter((row) => row.status === "connected")
      .map((row) => `${row.connectorId}:${row.provider.trim().toLowerCase()}`),
  );
  return rows.filter((row) => {
    if (row.status === "connected") return true;
    if (row.status === "revoked") return false;
    // Recover a pending/error Composio row only when this provider has no
    // connected row of its own. A sibling that shares the slug must not
    // pull a non-live row — and its dead providerRef — into the run.
    if (row.connectorId !== "composio") return false;
    if (row.status !== "pending" && row.status !== "error") return false;
    const providerKey = row.provider.trim().toLowerCase();
    if (!liveProviders.has(providerKey)) return false;
    return !connectedKeys.has(`composio:${providerKey}`);
  });
}

/** A run the person started for themselves: their own message, or a routine they made. */
export function personStartedRun(trigger: string, routinePersonCreated: boolean): boolean {
  return trigger === "user" || (trigger === "routine" && routinePersonCreated);
}

/**
 * Whether a run may act with the person's own sign-in: one they started, in their own private
 * thread. Never in a channel or group thread, where others would read what it finds.
 */
export function personRunFor(
  personStarted: boolean,
  thread: { departmentId?: string | null; groupId?: string | null; userId: string },
  userId: string,
): boolean {
  return personStarted && !thread.departmentId && !thread.groupId && thread.userId === userId;
}

/** Authorized connection metadata shared by model runs and unattended checks. */
export function connectedContext(
  rows: Array<{
    id: string;
    connectorId: string;
    provider: string;
    displayName: string;
    providerRef: string | null;
  }>,
): Pick<AdapterContext, "connectedConnections" | "connectedProviders"> {
  return {
    connectedConnections: rows.map((row) => ({
      id: row.id,
      connectorId: row.connectorId,
      externalId: row.provider,
      displayName: row.displayName,
      providerRef: row.providerRef ?? undefined,
    })),
    connectedProviders: rows
      .filter((row) => row.connectorId === "composio")
      .map((row) => row.provider),
  };
}
