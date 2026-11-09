import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GradientBorder, LOOP_COLORS } from "./GradientBorder";

const styles = () =>
  [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");

describe("GradientBorder", () => {
  it("while the agent works it is two comets going round an indigo track", () => {
    render(<GradientBorder loading={1} borderRadius="8px" />);
    const css = styles();
    expect(css).toContain("conic-gradient");
    expect(css).toContain("--loop-angle");
    // the cyan dot of the mark, and the violet end of the wordmark
    expect(css.toLowerCase()).toContain(LOOP_COLORS.cyan.toLowerCase());
    expect(css.toLowerCase()).toContain(LOOP_COLORS.violet.toLowerCase());
    expect(css).toContain("prefers-reduced-motion");
  });

  it("at rest it is the plain colour it is given, with no animation", () => {
    const { container } = render(
      <GradientBorder loading={0} borderColor="rgb(1, 2, 3)" />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(getComputedStyle(el).animationName).not.toContain("travel");
    expect(styles()).toContain("rgb(1, 2, 3)");
  });

  it("uses no rainbow: none of the old stops remain", () => {
    render(<GradientBorder loading={1} />);
    const css = styles().toUpperCase();
    for (const old of ["#1BBE84", "#BE1B55", "#A6BE1B"]) {
      expect(css).not.toContain(old);
    }
  });
});
