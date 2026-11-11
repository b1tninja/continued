import { reduceAgents, type AgentNodes } from "./reducer";
import { isAgentStateTerminal, type AgentEvent, type AgentNode } from "./types";

/** More than this many nodes and the oldest finished ones are dropped. */
export const AGENT_REGISTRY_MAX_NODES = 500;

/**
 * The nodes of the running process, kept by the pure reducer. Nothing here
 * persists: a restart starts empty. Producers call `apply`; readers call
 * `list`, which hands out copies, never a reference they could change.
 */
export class AgentRegistry {
  private nodes: AgentNodes = new Map();

  apply(event: AgentEvent): void {
    this.nodes = reduceAgents(this.nodes, event);
    if (this.nodes.size > AGENT_REGISTRY_MAX_NODES) this.evict();
  }

  list(): AgentNode[] {
    return [...this.nodes.values()].map((n) => ({ ...n }));
  }

  get(id: string): AgentNode | undefined {
    const node = this.nodes.get(id);
    return node ? { ...node } : undefined;
  }

  reset(): void {
    this.nodes = new Map();
  }

  private evict(): void {
    const next = new Map(this.nodes);
    for (const [id, node] of next) {
      if (next.size <= AGENT_REGISTRY_MAX_NODES) break;
      if (node.kind !== "main" && isAgentStateTerminal(node.state)) {
        next.delete(id);
      }
    }
    this.nodes = next;
  }
}

/** The process-wide registry the CLI feeds and `cn serve` reads. */
export const agentRegistry = new AgentRegistry();
