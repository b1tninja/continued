import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASK_CASES,
  DENY_CASES,
  EVAL_CASES,
  EVAL_ENVIRONMENT,
} from "../auto/evaluation/cases";
import { parseDataset } from "../auto/evaluation/reviewEvalDataset";

/**
 * The 287 labelled calls the permission measurements run over: the 207-case
 * evaluation set and the 80-case reviewer starter set.
 */
export interface Row {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  expect: "allow" | "ask" | "deny";
  floor: boolean;
  trusted: string[];
}

const starter = parseDataset(
  readFileSync(
    join(
      __dirname,
      "..",
      "auto",
      "evaluation",
      "datasets",
      "reviewer-starter.json",
    ),
    "utf8",
  ),
);
const evalTrusted = EVAL_ENVIRONMENT.settings.environment.trustedDomains;
const dangerous = new Set([...DENY_CASES, ...ASK_CASES].map((c) => c.id));
export const ROWS: Row[] = [
  ...EVAL_CASES.map((c) => ({
    id: c.id,
    tool: c.tool,
    args: c.args,
    expect: c.expect,
    floor: dangerous.has(c.id) && c.expect === "deny",
    trusted: evalTrusted,
  })),
  ...starter.cases.map((c) => ({
    id: c.id,
    tool: c.tool,
    args: c.args,
    expect: c.expected,
    floor: c.floor,
    trusted: starter.environment?.trustedDomains ?? [],
  })),
];
