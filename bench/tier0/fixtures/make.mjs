#!/usr/bin/env node
// Writes the fixture request dumps and the fixture history for
// score.columns.test.ts. Run it once after changing the shapes below; the
// written files are what the tests read, so a change here is a change to
// what the test asserts. From the repository root: node bench/tier0/fixtures/make.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const write = (rel, value) => {
  const file = path.join(here, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const clean = (dir) =>
  fs.rmSync(path.join(here, dir), { recursive: true, force: true });

const TAIL =
  "Act until the request is done. A reply with no tool call ends the turn.";
const system = (text) => ({ role: "system", content: text });
const user = (text, tail) => ({
  role: "user",
  content: tail ? `${text}\n\n${tail}` : text,
});
const call = (id, name, args) => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const toolResult = (id, text) => ({
  role: "tool",
  tool_call_id: id,
  content: text,
});
const body = (messages) => ({
  model: "fixture",
  messages,
  stream: true,
  max_tokens: 100,
});

// extends/: four requests, each the one before plus a reply and the next
// message, the tail on every user message. No churn.
clean("dumps/extends");
{
  const m1 = [system("S"), user("Do the thing", TAIL)];
  const m2 = [
    ...m1,
    call("c1", "List", { dirpath: "." }),
    toolResult("c1", "a.js"),
  ];
  const m3 = [
    ...m2,
    call("c2", "Read", { filepath: "a.js" }),
    toolResult("c2", "x"),
  ];
  const m4 = [
    ...m3,
    { role: "assistant", content: "Done." },
    user("Next, do the other thing", TAIL),
  ];
  write("dumps/extends/request-001.json", body(m1));
  write("dumps/extends/request-002.json", body(m2));
  write("dumps/extends/request-003.json", body(m3));
  write("dumps/extends/request-004.json", body(m4));
}

// churn/: request 3 changes the system text (the plan to act switch), request
// 4 carries a tail the earlier requests did not (message 1 rewritten), request
// 5 is the first two messages of request 4 and nothing more (a compaction).
// Three of five churn; the first at request 3, message 0.
clean("dumps/churn");
{
  const m1 = [system("PLAN"), user("Plan the thing")];
  const m2 = [
    ...m1,
    call("c1", "List", { dirpath: "." }),
    toolResult("c1", "a.js"),
  ];
  const m3 = [
    system("ACT"),
    ...m2.slice(1),
    call("c2", "PresentPlan", {}),
    toolResult("c2", "ok"),
  ];
  const m4 = [m3[0], user("Plan the thing", TAIL), ...m3.slice(2)];
  const m5 = m4.slice(0, 2);
  write("dumps/churn/request-001.json", body(m1));
  write("dumps/churn/request-002.json", body(m2));
  write("dumps/churn/request-003.json", body(m3));
  write("dumps/churn/request-004.json", body(m4));
  write("dumps/churn/request-005.json", body(m5));
}

// system-field/: the system text as a field of its own (an Anthropic-shaped
// body); the second request extends the first.
clean("dumps/system-field");
{
  const m1 = [user("Do the thing")];
  const m2 = [...m1, { role: "assistant", content: "Done." }, user("Thanks")];
  write("dumps/system-field/request-001.json", { system: "S", messages: m1 });
  write("dumps/system-field/request-002.json", { system: "S", messages: m2 });
}

// A loop history in the serve's /state shape: a plan turn of two requests,
// then three item attempts: the first with an approval answer in the middle
// (three requests), the second nudged for FinishItem (two requests, then the
// nudge, then one more), the third one request; then a re-plan of one request.
const h = (role, content, tools = []) => ({
  message: { role, content },
  toolCallStates: tools.map((name) => ({
    toolCall: { function: { name } },
    status: "done",
  })),
});
write("loop-history.json", [
  h("user", "Plan this work for the package in this folder"),
  h("assistant", "", ["List"]),
  h("assistant", "", ["PresentPlan"]),
  h(
    "user",
    "Work on this item of the plan, and only this item: Create src/a.js",
  ),
  h("assistant", "", ["Write"]),
  h(
    "user",
    'The person answered your question q1 ("Allow this call? Write: src/a.js"): Allowed.',
  ),
  h("assistant", "", ["Write"]),
  h("assistant", "", ["FinishItem"]),
  h(
    "user",
    "Work on this item of the plan, and only this item: Create test/a.test.js",
  ),
  h("assistant", "", ["Write"]),
  h("assistant", "I will now run the tests."),
  h(
    "user",
    "You ended without reporting. Call FinishItem now with the outcome and a one-line summary.",
  ),
  h("assistant", "", ["FinishItem"]),
  h("user", "Work on this item of the plan, and only this item: Run the tests"),
  h("assistant", "", ["Bash", "FinishItem"]),
  h(
    "user",
    "Every item is done. Review the plan and present it again, or stop.",
  ),
  h("assistant", "", ["PresentPlan"]),
]);
console.log("fixtures written under", here);
