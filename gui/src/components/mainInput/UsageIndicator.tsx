import {
  contextUsage,
  formatCost,
  formatTokens,
  summarizeSessionUsage,
} from "core/llm/utils/sessionUsage";
import { useMemo } from "react";
import { useAppSelector } from "../../redux/hooks";
import { Popover, PopoverButton, PopoverPanel } from "../ui";
import { HoverButton } from "./InputToolbar/HoverItem";
import { useToolbarWidthTier } from "./InputToolbar/widthTier";

/**
 * Usage readout in the row under the prompt: context used against the
 * model's window and the session's estimated cost. It is never moved into a
 * menu; as the row narrows it drops its "context" label and the route note
 * (both stay in its name). Pressing it opens the breakdown of tokens and cost
 * per model, so the details do not depend on hovering. Hidden until the first
 * request reports usage, since before that there is nothing to show.
 */
export function UsageIndicator() {
  const tier = useToolbarWidthTier();
  const usage = useAppSelector((s) => s.session.usage);
  const chatModels = useAppSelector(
    (s) => s.config.config.modelsByRole?.chat ?? [],
  );
  const selected = useAppSelector(
    (s) => s.config.config.selectedModelByRole.chat,
  );
  const answered = useAppSelector((s) => s.session.answeredRoute);
  // For a model with routes: the account that answered, and whether it is
  // a fallback rather than the model's first route
  const route =
    answered && selected?.routes && answered.model === selected.title
      ? {
          name: answered.route,
          fallback: answered.route !== selected.routes[0],
        }
      : undefined;

  const summary = useMemo(() => summarizeSessionUsage(usage), [usage]);
  const last = usage?.lastRequest;
  const contextLength = useMemo(() => {
    if (!last) return undefined;
    const match =
      chatModels.find(
        (m) => m.provider === last.provider && m.model === last.model,
      ) ??
      (selected?.model === last.model && selected.provider === last.provider
        ? selected
        : undefined) ??
      // A model with routes: the last request may have used another
      // route's id for it; the window is the model's
      (selected?.routes?.length ? selected : undefined);
    return match?.contextLength;
  }, [last, chatModels, selected]);
  const context = contextUsage(usage, contextLength);

  if (!usage || summary.requests === 0) return null;

  const percent = context ? Math.round(context.fraction * 100) : undefined;
  const models = Object.values(usage.byModel ?? {});

  const content = (
    <div
      className="flex flex-col gap-1 text-left text-xs"
      data-testid="usage-tooltip"
    >
      {route && (
        <span data-testid="usage-route">
          Answered through {route.name}
          {route.fallback
            ? ` (a fallback: ${selected?.routes?.[0]} did not answer)`
            : ""}
        </span>
      )}
      {context ? (
        <span>
          Context: {formatTokens(context.tokens)} of{" "}
          {formatTokens(context.limit)} tokens ({percent}%)
        </span>
      ) : (
        <span>Context window unknown for this model.</span>
      )}
      <span>
        Session: {formatTokens(summary.inputTokens)} in,{" "}
        {formatTokens(summary.outputTokens)} out
        {summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0
          ? `, ${formatTokens(summary.cacheReadTokens)} cache read, ${formatTokens(summary.cacheWriteTokens)} cache write`
          : ""}
      </span>
      <span>
        {summary.cost === undefined
          ? "Cost: no price known for these models, tokens only."
          : `Estimated cost: ${summary.costIsPartial ? "at least " : ""}${formatCost(summary.cost)}${summary.costIsPartial ? " (some models have no known price)" : ""}`}
      </span>
      {summary.cost !== undefined && summary.priceListDate && (
        <span className="text-description-muted" data-testid="usage-price-date">
          Estimate: OpenRouter prices from the list downloaded{" "}
          {summary.priceListDate.slice(0, 10)}
        </span>
      )}
      {models.length > 1 &&
        models.map((m) => (
          <span
            key={`${m.provider}/${m.model}`}
            className="text-description-muted"
          >
            {m.model}: {formatTokens(m.inputTokens)} in,{" "}
            {formatTokens(m.outputTokens)} out
            {m.pricedRequests > 0 ? `, ${formatCost(m.cost)}` : ""}
          </span>
        ))}
    </div>
  );

  const costText =
    summary.cost !== undefined
      ? `${summary.costIsPartial ? "at least " : ""}${formatCost(summary.cost)}`
      : undefined;
  const showRoute = !!route?.fallback && tier !== "narrow";
  // What the row shows; the name starts with it, so speech and sight agree
  const visible =
    (context
      ? `${percent}%${tier === "wide" ? " context" : ""}`
      : formatTokens(summary.inputTokens + summary.outputTokens)) +
    (summary.cost !== undefined ? ` · ${formatCost(summary.cost)}` : "") +
    (showRoute ? ` · via ${route?.name}` : "");
  const meaning = [
    context
      ? `context ${percent}% used`
      : "tokens this session, context window unknown",
    costText ? `estimated cost ${costText}` : "no price known",
    route?.fallback ? `answered via ${route.name}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover className="relative flex flex-none">
      <PopoverButton
        as={HoverButton}
        aria-label={`${visible}: ${meaning}. Show usage details`}
        data-testid="usage-indicator"
        className="flex-none gap-1 px-0.5 [font-size:inherit] tabular-nums"
      >
        {context ? (
          <span
            className={`relative h-[3px] ${tier === "narrow" ? "w-3" : "w-6"} overflow-hidden rounded-xs bg-command-border`}
            aria-hidden="true"
          >
            <span
              className={`absolute top-0 left-0 h-full ${context.fraction >= 0.9 ? "bg-error" : "bg-description"}`}
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : null}
        <span aria-hidden="true">{visible}</span>
      </PopoverButton>
      <PopoverPanel
        anchor="top end"
        data-testid="usage-panel"
        className="z-[200000] max-w-[90vw] rounded border border-solid border-border bg-vsc-input-background p-2 text-xs text-foreground shadow-md"
      >
        {content}
      </PopoverPanel>
    </Popover>
  );
}
