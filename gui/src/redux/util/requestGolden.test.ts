import { sha256Hex } from "core/util/secretScan/sha256";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildChatRequest } from "./buildChatRequest";
import { IDE_SCENARIOS } from "./segmentScenarios";

/**
 * Byte-identity guard for the prompt-segment work: the request each scenario
 * builds (messages, tools, task list message) hashes to the value recorded on
 * main before the manifest code was added. A change to any prompt text or
 * ordering fails here and needs a deliberate update:
 * `WRITE_GOLDEN=1 npx vitest run src/redux/util/requestGolden.test.ts`.
 */
const GOLDEN_FILE = join(__dirname, "requestGolden.json");

function requestJson(name: string): string {
  const request = buildChatRequest(IDE_SCENARIOS[name]());
  return JSON.stringify({
    messages: request.messages,
    tools: request.completionOptions.tools ?? null,
    taskList: request.taskListMessage ?? null,
  });
}

describe("IDE requests are byte-identical to the recorded goldens", () => {
  const actual = Object.fromEntries(
    Object.keys(IDE_SCENARIOS).map((name) => [
      name,
      sha256Hex(requestJson(name)),
    ]),
  );
  if (process.env.WRITE_GOLDEN) {
    writeFileSync(GOLDEN_FILE, JSON.stringify(actual, null, 2) + "\n");
  }
  const golden = existsSync(GOLDEN_FILE)
    ? JSON.parse(readFileSync(GOLDEN_FILE, "utf8"))
    : {};
  for (const name of Object.keys(IDE_SCENARIOS)) {
    it(name, () => {
      // A failing hash prints the request it hashed, to find what differs.
      expect(actual[name], requestJson(name)).toBe(golden[name]);
    });
  }
});
