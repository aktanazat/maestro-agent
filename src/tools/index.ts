import { ToolRegistry } from "./registry.js";
import { fsTools } from "./fs/index.js";
import { vcsTools } from "./vcs/index.js";
import { codeTools } from "./code/index.js";
import { execTools } from "./exec/index.js";
import { planTools } from "./plan/index.js";
import { agentTools } from "./agent/index.js";
import { githubTools } from "./gh/index.js";
import { webTools } from "./web/index.js";
import type { Tool } from "./types.js";

/** Every tool maestro ships, grouped by the module that owns its namespace. */
const ALL_TOOLS: Tool[] = [
  ...fsTools, // fs.*
  ...vcsTools, // git.*
  ...codeTools, // code.*
  ...execTools, // shell.*
  ...planTools, // plan.*
  ...agentTools, // agent.*
  ...githubTools, // github.*
  ...webTools, // web.*
];

/**
 * Build the full registry. Adding a tool means adding it to a namespace module and exporting
 * it — there is no central dispatch to edit, which is exactly how the registry stays coherent
 * at 60 tools instead of degenerating into a 60-arm switch.
 */
export function buildRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll(ALL_TOOLS);
}

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext, ToolServices } from "./types.js";
