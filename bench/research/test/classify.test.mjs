import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../lib/classify.mjs";
import { excerpt, reduce } from "../lib/excerpt.mjs";
import { labels, template } from "./helpers.mjs";

test("a known form with the tools list rendered is decided", () => {
  const r = classify(
    "{% if tools %}x{% endif %}<tool_call>\n<function=a><parameter=b>",
  );
  assert.equal(r.outcome, "decided");
  assert.equal(r.dialect, "qwen-xml");
  assert.equal(r.toolsRendered, true);
});

test("hermes-json is dropped only when a specific rule also matched", () => {
  const wrapped =
    '{{ tools }} <tool_call> "name" <tool_call>\n<function= <parameter=';
  assert.equal(classify(wrapped).dialect, "qwen-xml");
  assert.equal(
    classify('{{ tools }} <tool_call> "name"').dialect,
    "hermes-json",
  );
});

test("a rule needs ALL its markers", () => {
  assert.equal(classify("{{ tools }} <function=a>").outcome, "undecided");
});

test("no template, unknown form, and two forms are undecided, never guessed", () => {
  assert.equal(classify(null).reason, "no-template");
  assert.equal(classify("").outcome, "undecided");
  const unknown = classify("{{ tools }} <|unheard_of|>[{}]");
  assert.equal(unknown.outcome, "undecided");
  assert.equal(unknown.reason, "tools-rendered-no-known-marker");
  const both = classify("{{ tools }} [TOOL_CALLS] <TOOLCALL>");
  assert.equal(both.outcome, "undecided");
  assert.equal(both.reason, "multiple");
  assert.deepEqual(both.hits.sort(), ["mistral", "toolcall-json"]);
});

test("no tools in the template is the decided answer 'none'", () => {
  const r = classify("{{ messages }}");
  assert.equal(r.outcome, "none");
  assert.equal(r.dialect, "none");
});

test("a marker inside a jinja comment does not count", () => {
  assert.equal(classify("{# <TOOLCALL> #}{{ tools }}").outcome, "undecided");
});

test("a form written only in history is flagged as not rendering the tools list", () => {
  const r = classify("<｜tool▁call▁begin｜>");
  assert.equal(r.dialect, "deepseek-tokens");
  assert.equal(r.toolsRendered, false);
  assert.match(r.reason, /history writer only/);
});

test("excerpt and reduce never return the whole template", () => {
  const big = "x".repeat(5000) + "<TOOLCALL>" + "y".repeat(5000);
  assert.ok(excerpt(big).length <= 1200);
  assert.ok(excerpt(big).includes("<TOOLCALL>"));
  assert.ok(reduce(big).length < 400);
  assert.equal(classify(reduce(big)).dialect, "toolcall-json");
});

function score(set) {
  let decided = 0;
  let correct = 0;
  let undecided = 0;
  let undecidedNovel = 0;
  const wrong = [];
  for (const [repo, l] of Object.entries(set)) {
    const r = classify(template(l.file));
    if (r.outcome === "undecided") {
      undecided++;
      if (l.truth === "novel") undecidedNovel++;
      else wrong.push(`${repo}: undecided but truth ${l.truth}`);
    } else {
      decided++;
      if (r.dialect === l.truth) correct++;
      else wrong.push(`${repo}: said ${r.dialect}, truth ${l.truth}`);
    }
  }
  return { decided, correct, undecided, undecidedNovel, wrong };
}

test("dev set (31 samples were used to write the rules; this is a fit, not a validation)", () => {
  const s = score(labels().dev);
  assert.deepEqual(s.wrong, []);
  assert.ok(s.decided >= 15);
});

test("first hold-out set (21): measured before the rules were touched, now a fit", () => {
  // First run, before any rule changed: 14 of 15 decided verdicts right; the
  // one error was Seed-OSS (<seed:tool_call> wraps the Qwen inner form and the
  // qwen-xml rule accepted it). The wrapper check and five forms ruled from
  // this set fix that, so these 21 are no longer a validation. The README
  // keeps the first-run numbers.
  const s = score(labels().holdout);
  assert.deepEqual(s.wrong, []);
  assert.equal(s.decided, 20);
  assert.equal(s.correct, 20);
  assert.equal(s.undecided, 1);
  assert.equal(s.undecidedNovel, 1);
});

test("fresh hold-out (20 repos not used before): precision and the two known misses", () => {
  // Labels were written by hand before the classifier ran on these. The two
  // misses are known forms the rules do not see: SmolLM3 writes "name" with
  // escaped quotes and Falcon-H1 with single quotes, so the hermes-json rule's
  // literal "name" is absent. They stay undecided, not guessed.
  const s = score(labels().fresh);
  assert.deepEqual(s.wrong.sort(), [
    "HuggingFaceTB/SmolLM3-3B: undecided but truth hermes-json",
    "tiiuae/Falcon-H1-7B-Instruct: undecided but truth hermes-json",
  ]);
  assert.equal(s.decided, 16);
  assert.equal(s.correct, 16);
  assert.equal(s.undecided, 4);
  assert.equal(s.undecidedNovel, 2);
});

test("Seed-OSS is its own form, not qwen-xml", () => {
  const r = classify(template("ByteDance-Seed__Seed-OSS-36B-Instruct.jinja"));
  assert.equal(r.dialect, "seed-xml");
});
