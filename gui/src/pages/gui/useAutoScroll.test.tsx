import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoScroll } from "./useAutoScroll";

let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const history = [
  { message: { role: "user", id: "1", content: "hi" } },
  { message: { role: "assistant", id: "2", content: "yo" } },
] as any;

/** A box whose geometry the test sets directly. */
function Harness({ box }: { box: { current: HTMLDivElement | null } }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useAutoScroll(ref, history);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        box.current = el;
      }}
    />
  );
}

function geometry(el: HTMLDivElement, g: { height: number; client: number }) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => g.height,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => g.client,
  });
}

async function setup() {
  const box = { current: null as HTMLDivElement | null };
  render(<Harness box={box} />);
  const el = box.current!;
  const g = { height: 1000, client: 400 };
  geometry(el, g);
  el.scrollTop = 600;
  const scrollTo = async (top: number) => {
    await act(async () => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  };
  const resize = async () => {
    await act(async () => {
      resizeCallbacks.forEach((cb) => cb());
    });
  };
  // The view starts at the bottom, as a chat does
  await scrollTo(600);
  return { el, g, scrollTo, resize };
}

describe("useAutoScroll", () => {
  it("follows new content while the view is at the bottom", async () => {
    const { el, g, resize } = await setup();
    g.height = 1400;
    await resize();
    expect(el.scrollTop).toBe(1400);
  });

  it("stops following when the user scrolls up, and resumes at the bottom", async () => {
    const { el, g, scrollTo, resize } = await setup();
    await scrollTo(200);
    g.height = 1400;
    await resize();
    expect(el.scrollTop).toBe(200);

    // Back to the bottom, within a few pixels
    await scrollTo(g.height - g.client - 3);
    g.height = 1800;
    await resize();
    expect(el.scrollTop).toBe(1800);
  });

  it("a panel below growing is not the user leaving the bottom", async () => {
    const { el, g, scrollTo, resize } = await setup();
    // The box shrinks under a growing plan panel; a late scroll event from
    // our own scroll arrives while the view is no longer exactly at the bottom
    g.client = 300;
    await scrollTo(600);
    g.height = 1200;
    await resize();
    expect(el.scrollTop).toBe(1200);
  });
});
