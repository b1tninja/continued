import { render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { LoopIcon } from "./LoopIcon";
import { LOOP_DOT_COLOR, LOOP_GRADIENT_STOPS } from "./loopGradient";

describe("LoopIcon", () => {
  it("draws one stroke painted with the brand gradient and a dot", () => {
    const { container } = render(<LoopIcon title="Loop" />);
    const svg = container.querySelector("svg")!;
    const gradient = svg.querySelector("linearGradient")!;
    const stops = [...gradient.querySelectorAll("stop")];
    expect(stops.map((s) => s.getAttribute("stop-color"))).toEqual([
      ...LOOP_GRADIENT_STOPS,
    ]);
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.querySelector("path")!.getAttribute("stroke")).toBe(
      `url(#${gradient.id})`,
    );
    expect(svg.querySelector("circle")!.getAttribute("fill")).toBe(
      LOOP_DOT_COLOR,
    );
    expect(svg.getAttribute("role")).toBe("img");
  });

  it("gives each instance its own gradient id", () => {
    const { container } = render(
      <>
        <LoopIcon />
        <LoopIcon />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map(
      (g) => g.id,
    );
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(/^[\w-]+$/);
  });

  it("is flat and follows the theme without the gradient", () => {
    const { container } = render(<LoopIcon gradient={false} />);
    expect(container.querySelector("linearGradient")).toBeNull();
    expect(container.querySelector("circle")).toBeNull();
    expect(container.querySelector("path")!.getAttribute("stroke")).toBe(
      "currentColor",
    );
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("sizes by height and keeps the figure eight nearly twice as wide", () => {
    for (const size of [16, 20, 24]) {
      const { container } = render(<LoopIcon size={size} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("height")).toBe(String(size));
      expect(Number(svg.getAttribute("width"))).toBeGreaterThan(size * 1.7);
    }
  });

  it("puts the dot on the requested lobe", () => {
    const { container } = render(<LoopIcon dot="left" />);
    expect(Number(container.querySelector("circle")!.getAttribute("cx"))).toBe(
      161.5,
    );
  });
});

describe("the second Loop mark is gone", () => {
  const root = join(__dirname, "..", "..", "..", "..");
  const SKIP = new Set(["node_modules", ".git", "dist", "out", "build"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(tsx?|svg|mdx?)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("no GUI source draws a loop of its own or mentions the two-halves mark", () => {
    const files = [
      ...walk(join(root, "gui", "src")),
      ...walk(join(root, "brand-src")),
      ...walk(join(root, "docs", "logo")),
    ].filter((f) => !f.endsWith("LoopIcon.test.tsx"));
    const hits = files
      .filter((f) =>
        /yin and yang|loop-phase-(planning|building)|LOOP_COLORS\.(cyan|indigo)\b.*stroke/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(root, f).split(sep).join("/"));
    expect(hits).toEqual([]);
  });

  it("every brand SVG with the mark draws one closed path, never two halves", () => {
    for (const f of [
      "brand-src/mark.svg",
      "brand-src/mark-small.svg",
      "brand-src/mark-mono.svg",
      "docs/logo/light.svg",
      "docs/logo/dark.svg",
    ]) {
      const svg = readFileSync(join(root, f), "utf8");
      const loops = svg.match(/<path d="M[^"]*C[^"]*"/g) ?? [];
      expect(loops, f).toHaveLength(1);
    }
  });
});
