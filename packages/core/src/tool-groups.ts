import { ADMIN_TOOL_NAMES, FLEET_TOOL_NAMES } from "@rakazo/contracts";

export type ToolGroupId =
  | "web"
  | "computer"
  | "files"
  | "media"
  | "memory"
  | "work"
  | "delegation"
  | "calls";

export const TOOL_GROUPS: readonly {
  id: ToolGroupId;
  name: string;
  tools: readonly string[];
  defaultOn: boolean;
}[] = [
  { id: "web", name: "Web", tools: ["web_search", "web_fetch"], defaultOn: true },
  {
    id: "computer",
    name: "Computer and browser",
    tools: [
      "computer_observe",
      "computer_act",
      "browser_navigate",
      "browser_snapshot",
      "browser_act",
      "shell",
      "open_path",
      "launch_app",
      "request_takeover",
    ],
    defaultOn: true,
  },
  {
    id: "files",
    name: "Files",
    tools: ["list_files", "read_file", "write_file", "attach_file"],
    defaultOn: true,
  },
  {
    id: "media",
    name: "Media",
    tools: ["render_plot", "generate_image", "generate_video"],
    defaultOn: true,
  },
  {
    id: "memory",
    name: "Memory and notes",
    tools: [
      "remember",
      "save_shared_memory",
      "save_memory",
      "recall_memory",
      "forget_memory",
      "scratchpad_list",
      "scratchpad_add",
      "scratchpad_update",
      "scratchpad_complete",
      "scratchpad_remove",
    ],
    defaultOn: true,
  },
  {
    id: "work",
    name: "Work items",
    tools: [
      "board_tickets",
      "ticket_get",
      "ticket_create",
      "ticket_update",
      "ticket_comment",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
    ],
    defaultOn: true,
  },
  {
    id: "delegation",
    name: "Delegation",
    tools: [
      "run_subagent",
      "cloud_agent_launch",
      "cloud_agent_status",
      "cloud_agent_reply",
      "cloud_agent_cancel",
    ],
    defaultOn: true,
  },
  { id: "calls", name: "Calls", tools: ["call_user", "end_call"], defaultOn: false },
];

/** Built-in tools the setup wizard never switches: the bot needs them to work at all. */
export const ALWAYS_ON_TOOLS: readonly string[] = [
  "ask_user",
  "message_user",
  "request_secret",
  "list_secrets",
  "secret_request",
  "forget_secret",
  "connect_app",
  "add_mcp_server",
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
  "search_history",
  "read_history",
  "task_catalog",
  "propose_instructions_update",
  "create_space",
  "spawn_bot",
  "update_bot",
  "archive_bot",
  "message_bot",
  "handoff_to_bot",
  "connect_agent",
  "respond_agent_connection",
  "message_agent",
  ...FLEET_TOOL_NAMES,
  ...ADMIN_TOOL_NAMES,
];

export const DEFAULT_OFF_GROUPS: readonly ToolGroupId[] = ["calls"];

export function disabledToolsFor(offGroups: readonly ToolGroupId[]): string[] {
  return TOOL_GROUPS.filter((g) => offGroups.includes(g.id))
    .flatMap((g) => g.tools)
    .sort();
}

export function groupsOffFor(disabledTools: readonly string[]): ToolGroupId[] {
  const disabled = new Set(disabledTools);
  return TOOL_GROUPS.filter((g) => g.tools.every((t) => disabled.has(t))).map((g) => g.id);
}
