/**
 * Which workspace block files are applied on this load. MCP, model and data
 * files from a folder are left out until that folder is trusted for them.
 */

import {
  AssistantUnrolled,
  ConfigValidationError,
} from "@continuedev/config-yaml";

import { InternalMcpOptions } from "..";
import { heldMcpServersFromBlock } from "../context/mcp/workspaceMcpPolicy";
import {
  blockScope,
  ProjectConfigScope,
  scopeIsTrusted,
  TRUST_GATED_BLOCK_SCOPES,
  untrustedConfigError,
} from "./projectTrust";

import type { IDE } from "..";

export interface LoadedBlock {
  path: string;
  content: string;
  blockType: string;
}

export async function selectWorkspaceBlocks(
  ide: IDE,
  blocks: LoadedBlock[],
  workspaceDirs: string[],
): Promise<{
  kept: LoadedBlock[];
  heldMcpServers: InternalMcpOptions[];
  notices: ConfigValidationError[];
}> {
  const kept: LoadedBlock[] = [];
  const heldMcpServers: InternalMcpOptions[] = [];
  const notices: ConfigValidationError[] = [];
  const gated = new Map<
    string,
    { dir: string; scope: ProjectConfigScope; blocks: LoadedBlock[] }
  >();

  for (const block of blocks) {
    const scope = blockScope(block.blockType, block.path, workspaceDirs);
    if (!scope || !TRUST_GATED_BLOCK_SCOPES.includes(scope.scope)) {
      kept.push(block);
      continue;
    }
    const key = `${scope.dir}\0${scope.scope}`;
    const group = gated.get(key) ?? {
      dir: scope.dir,
      scope: scope.scope,
      blocks: [],
    };
    group.blocks.push(block);
    gated.set(key, group);
  }

  for (const group of gated.values()) {
    const trusted = await scopeIsTrusted(
      ide,
      group.dir,
      group.scope,
      group.blocks.map((block) => ({
        path: block.path,
        content: block.content,
      })),
    );
    if (trusted) {
      kept.push(...group.blocks);
      continue;
    }
    const notice = untrustedConfigError(
      group.dir,
      group.scope,
      group.blocks.length,
    );
    if (notice) notices.push(notice);
    if (group.scope === "mcp") {
      for (const block of group.blocks) {
        heldMcpServers.push(
          ...heldMcpServersFromBlock(block.path, block.content),
        );
      }
    }
  }

  return { kept, heldMcpServers, notices };
}

function blockName(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const name = (block as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Workspace blocks may add a name the user does not have. They may not take
 * a name the user's own config already uses. `mergeUnrolledAssistants` keeps
 * the first copy, and the workspace copy is passed first on the override path.
 */
export function preferUserOwnedBlocks(
  current: AssistantUnrolled,
  incoming: AssistantUnrolled,
): AssistantUnrolled {
  const next: AssistantUnrolled = { ...incoming };
  for (const blockType of ["models", "mcpServers", "data"] as const) {
    const taken = new Set<string>();
    for (const block of current[blockType] ?? []) {
      const name = blockName(block);
      if (name) taken.add(name);
    }
    const blocks = next[blockType];
    if (!blocks) continue;
    const filtered = blocks.filter((block) => {
      const name = blockName(block);
      return !name || !taken.has(name);
    });
    (next as Record<string, unknown>)[blockType] = filtered;
  }
  return next;
}
