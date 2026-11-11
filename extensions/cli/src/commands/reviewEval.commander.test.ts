import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { addCommonOptions } from "../shared-options.js";

import {
  registerReviewerCommand,
  type ReviewEvalOptions,
} from "./reviewEval.js";

// The real root options and the real reviewer registration, parsed by commander.
async function parse(argv: string[]): Promise<ReviewEvalOptions | undefined> {
  let seen: ReviewEvalOptions | undefined;
  const program = new Command().exitOverride();
  addCommonOptions(program).argument("[prompt]");
  registerReviewerCommand(
    program,
    async () => {},
    async (o) => {
      seen = o;
      return 0;
    },
  );
  await program.parseAsync(["node", "continuous", ...argv]);
  return seen;
}

describe("reviewer eval --config through commander", () => {
  it("reaches the eval after the subcommand", async () => {
    const o = await parse(["reviewer", "eval", "--config", "a.yaml"]);
    expect(o?.config).toBe("a.yaml");
  });

  it("reaches the eval before the subcommand", async () => {
    const o = await parse(["--config", "b.yaml", "reviewer", "eval"]);
    expect(o?.config).toBe("b.yaml");
  });

  it("leaves other options on the subcommand", async () => {
    const o = await parse(["reviewer", "eval", "--repeat", "3", "--run"]);
    expect(o?.repeat).toBe("3");
    expect(o?.run).toBe(true);
    expect(o?.config).toBeUndefined();
  });
});
