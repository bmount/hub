import { PLANNED } from "../src/verbs/planned";
import { toolName } from "../src/mcp/policy";

const PLANNED_TOOLS = new Set([...PLANNED.keys()].map(toolName));
/** Tool names without the planned stubs, so pinned lists pin the live surface. */
export const live = (names: string[]) => names.filter((n) => !PLANNED_TOOLS.has(n));
