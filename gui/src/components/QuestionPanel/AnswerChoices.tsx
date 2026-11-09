import { useState } from "react";

interface AnswerChoicesProps {
  options: string[];
  /** The agent's recommendation, marked on its button */
  pick?: string;
  /** The answer already given, shown as selected */
  selected?: string;
  disabled?: boolean;
  /** Placeholder for the "Other" field */
  otherPlaceholder?: string;
  maxLength?: number;
  testIdPrefix: string;
  onChoose: (answer: string) => void;
}

/**
 * The choices a question offers, as buttons, and "Other" for an answer of
 * one's own: it opens a field, so the person is never limited to the agent's
 * list.
 */
export function AnswerChoices({
  options,
  pick,
  selected,
  disabled,
  otherPlaceholder = "Your answer",
  maxLength,
  testIdPrefix,
  onChoose,
}: AnswerChoicesProps) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const buttonClass =
    "cursor-pointer rounded border border-solid border-border px-1.5 py-0.5 text-xs text-foreground disabled:cursor-default disabled:opacity-50";
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`${testIdPrefix}-option`}
            disabled={disabled}
            title={
              option === pick
                ? "The agent's recommendation"
                : "Answer with this choice"
            }
            className={`${buttonClass} ${
              selected === option
                ? "bg-button text-button-foreground"
                : "bg-transparent hover:bg-input"
            }`}
            onClick={() => onChoose(option)}
          >
            {option}
            {option === pick ? " (recommended)" : ""}
          </button>
        ))}
        <button
          type="button"
          data-testid={`${testIdPrefix}-other`}
          disabled={disabled}
          aria-expanded={other}
          className={`${buttonClass} bg-transparent hover:bg-input`}
          onClick={() => setOther(!other)}
        >
          Other…
        </button>
      </div>
      {other && (
        <form
          className="mt-1 flex min-w-0 flex-wrap items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onChoose(text.trim());
            setText("");
          }}
        >
          <input
            data-testid={`${testIdPrefix}-other-input`}
            autoFocus
            value={text}
            maxLength={maxLength}
            placeholder={otherPlaceholder}
            onChange={(e) => setText(e.target.value)}
            className="min-w-0 flex-1 basis-40 rounded border border-solid border-border bg-input px-1 text-xs text-foreground placeholder:text-description-muted"
          />
          <button
            type="submit"
            data-testid={`${testIdPrefix}-other-send`}
            disabled={disabled || !text.trim()}
            className={`${buttonClass} bg-transparent hover:bg-input`}
          >
            Answer
          </button>
        </form>
      )}
    </div>
  );
}
