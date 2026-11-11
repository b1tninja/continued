import { ToolTip } from "../gui/Tooltip";

interface TabButtonProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  tabId?: string;
  /** A command (Back), not one of the tabs: no tab role and no selection. */
  action?: boolean;
}

/**
 * One entry of the Settings navigation. A real button with an accessible name
 * (the label shows beside the icon below `sm` and from `md`; in between the
 * icon stands alone and the label is its tooltip). In a `tablist` only the
 * selected tab is in the Tab order; the arrow keys move between tabs.
 */
export function TabButton({
  label,
  icon,
  isActive,
  onClick,
  tabId,
  action = false,
}: TabButtonProps) {
  return (
    <ToolTip
      content={label}
      place="right"
      className="text-xs max-sm:!hidden md:!hidden"
    >
      <button
        type="button"
        {...(action
          ? {}
          : {
              role: "tab",
              "aria-selected": isActive,
              tabIndex: isActive ? 0 : -1,
            })}
        aria-label={label}
        className={`flex min-h-6 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border-0 text-xs whitespace-nowrap text-foreground hover:brightness-125 sm:justify-center md:justify-start ${
          isActive
            ? "bg-vsc-input-background px-2 py-2"
            : "bg-transparent px-2 py-2 text-description"
        }`}
        onClick={onClick}
        data-testid={tabId ? `tab-${tabId}` : undefined}
      >
        {icon}
        <span className="text-description sm:hidden md:inline">{label}</span>
      </button>
    </ToolTip>
  );
}
