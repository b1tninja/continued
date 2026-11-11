import { ButtonHTMLAttributes, forwardRef } from "react";
import styled from "styled-components";
import { cn } from "../../../util/cn";

/**
 * A plain hover wrapper. It is not interactive: put the control inside it.
 * For a control, use `HoverButton`.
 */
const HoverItem = styled.span<{ isActive?: boolean; px?: number }>`
  padding: 0 ${(props) => props.px ?? 4}px;
  padding-top: 2px;
  padding-bottom: 2px;
  cursor: pointer;
  transition:
    color 200ms,
    background-color 200ms,
    box-shadow 200ms;
`;

type HoverButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> & {
  /** Required: these buttons are mostly an icon, so the name is not visible. */
  "aria-label": string;
};

/**
 * A toolbar control: a real button with a name, at least 24 by 24 px, in the
 * Tab order. Icons inside it are `h-4 w-4`.
 */
export const HoverButton = forwardRef<HTMLButtonElement, HoverButtonProps>(
  ({ className, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-description transition-colors duration-200 hover:brightness-125 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-border-focus",
        className,
      )}
      {...props}
    />
  ),
);
HoverButton.displayName = "HoverButton";

export default HoverItem;
