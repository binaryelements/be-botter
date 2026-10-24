import type { BotThread, Department, DepartmentUser } from "@rakazo/contracts";
import type { MobileMessage } from "./api";
import { currentApiBase, rpc, selectedSpaceId } from "./api";
import { currentSessionGeneration } from "./session";

/** Which of a bot's threads a route opens: a department channel or a supervised person's. */
export type BotThreadScope = { departmentId: string } | { userId: string };

export function botThreadScope(params: {
  departmentId?: string;
  userId?: string;
}): BotThreadScope | undefined {
  if (params.departmentId) return { departmentId: params.departmentId };
  if (params.userId) return { userId: params.userId };
  return undefined;
}

/** Who wrote a user message in a channel, when it was someone else; nothing when unknown. */
export function channelSenderName(
  message: Pick<MobileMessage, "role" | "userId">,
  context: {
    me: string;
    departmentId?: string;
    users?: Pick<DepartmentUser, "userId" | "name">[];
    threads?: BotThread[];
  },
): string | undefined {
  if (
    message.role !== "user" ||
    !context.departmentId ||
    !message.userId ||
    message.userId === context.me
  )
    return undefined;
  return (
    context.users?.find((user) => user.userId === message.userId)?.name ??
    context.threads?.find((thread) => thread.userId === message.userId)?.name
  );
}

let departments: { key: string; result: Promise<Department[]> } | null = null;

/** The current space's departments, fetched once per space and session. */
export function loadDepartments(): Promise<Department[]> {
  const key = JSON.stringify([currentApiBase(), selectedSpaceId(), currentSessionGeneration()]);
  if (departments?.key !== key) {
    const result = rpc<Department[]>("departments/list").catch((error: unknown) => {
      if (departments?.result === result) departments = null;
      throw error;
    });
    departments = { key, result };
  }
  return departments.result;
}
