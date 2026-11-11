import type { ListedCall } from "core/tools/permissions/audit/listing";
import type { ReactNode } from "react";
import { DecisionChip, DECISION_LABEL } from "../badges";
import { AgentChip, ByChip } from "./AuditChips";
import { formatTime } from "./auditVocab";

/** One call: when, tool, what was decided and by whom, which agent, a masked preview. */
export function AuditRow({
  call,
  onOpen,
  extra,
  below,
  when,
}: {
  call: ListedCall;
  onOpen: () => void;
  extra?: ReactNode;
  below?: ReactNode;
  /** Replaces the time, e.g. "asked 3 h ago" */
  when?: ReactNode;
}) {
  const label = `${call.tool}, ${DECISION_LABEL[call.policy]}, decided by ${call.by}`;
  return (
    <li
      data-testid={`audit-row-${call.callId}`}
      className="list-none rounded-sm border border-solid border-border px-2 py-1"
    >
      <div className="flex flex-wrap items-center gap-1">
        <DecisionChip decision={call.policy} />
        <ByChip by={call.by} />
        <AgentChip agent={call.agent} />
        <span className="text-2xs text-description-muted">
          {when ?? formatTime(call.ts)}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2">
        <strong className="text-xs break-all">{call.tool}</strong>
        <code
          className="min-w-0 flex-1 truncate font-mono text-2xs"
          title={call.summary}
        >
          {call.summary}
        </code>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Show details: ${label}`}
          className="min-h-6 cursor-pointer rounded-sm border border-solid border-border bg-transparent px-2 text-xs text-foreground"
        >
          Details
        </button>
        {extra}
      </div>
      {below}
    </li>
  );
}
