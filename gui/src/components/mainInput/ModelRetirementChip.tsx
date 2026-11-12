import type { RetirementNotice } from "core/util/modelRetirement";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";

/** The chip's words: short, with the date when there is one. */
export function retirementChipText(n: RetirementNotice): string {
  switch (n.severity) {
    case "retired":
      return "retired";
    case "retiring":
      return `retires ${n.retiresAt}`;
    case "possible":
      return `may retire ${n.retiresAt}`;
    default:
      return "deprecated";
  }
}

function tooltip(n: RetirementNotice): string {
  const source =
    n.from === "live"
      ? "From your key's model list."
      : `From Anthropic's deprecations page, read ${n.fetchedOn}: ${n.sourceUrl}`;
  return `${n.message} ${source} Click to hide.`;
}

/**
 * A warning chip beside the model picker when the selected Anthropic model is
 * deprecated, retired or retiring within 60 days (core/util/modelRetirement.ts).
 * Offline: the checked-in table and the lifecycle your key last returned from
 * Test connection. Click hides it for that notice; it never blocks anything.
 */
export function ModelRetirementChip() {
  const ideMessenger = useContext(IdeMessengerContext);
  const model = useAppSelector(selectSelectedChatModel);
  const [notice, setNotice] = useState<RetirementNotice>();
  const provider = model?.provider;
  const id = model?.model;

  useEffect(() => {
    setNotice(undefined);
    if (provider !== "anthropic" || !id) return;
    let live = true;
    ideMessenger
      .request("model/retirementNotice", { provider, model: id })
      .then((res) => {
        if (live && res.status === "success") setNotice(res.content.notice);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [provider, id]);

  if (!notice || !provider || !id) return null;
  return (
    <button
      type="button"
      className="ml-1 hidden shrink-0 cursor-pointer rounded border border-solid border-warning bg-transparent px-1 text-[10px] text-warning md:inline"
      data-testid="model-retirement-chip"
      title={tooltip(notice)}
      onClick={() => {
        setNotice(undefined);
        void ideMessenger.request("model/dismissRetirementNotice", {
          provider,
          model: id,
        });
      }}
    >
      {retirementChipText(notice)}
    </button>
  );
}
