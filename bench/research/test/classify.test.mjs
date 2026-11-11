import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../lib/classify.mjs";
import { excerpt, reduce } from "../lib/excerpt.mjs";
import { labels, template } from "./helpers.mjs";

test("a known form with the tools list rendered is decided", () => {
  const r = classify("{% if tools %}x{% endif %}<function=a><parameter=b>");
  assert.equal(r.outcome, "decided");
  assert.equal(r.dialect, "qwen-xml");
  assert.equal(r.toolsRendered, true);
});

test("hermes-json is dropped only when a specific rule also matched", () => {
  const wrapped = '{{ tools }} <tool_call> "name" <function= <parameter=';
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
  const unknown = classify("{{ tools }} <|tool_call|>[{}]");
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

test("hold-out set: templates the rules were not written on", () => {
  const set = labels().holdout;
  const s = score(set);
  // Measured on the first run, before any rule was touched. The one known
  // error is Seed-OSS: <seed:tool_call> wraps the Qwen inner form, which the
  // qwen-xml rule accepts. If a rule change fixes it, update this test and the README.
  assert.deepEqual(s.wrong, [
    "ByteDance-Seed/Seed-OSS-36B-Instruct: said qwen-xml, truth novel",
  ]);
  assert.equal(s.decided, 15);
  assert.equal(s.correct, 14);
  assert.equal(s.undecided, 6);
  assert.equal(s.undecidedNovel, 6);
  const fresh = Object.fromEntries(
    Object.entries(set).filter(([, l]) => !l.sameFamilyAsDev),
  );
  const f = score(fresh);
  assert.equal(f.decided, 12);
  assert.equal(f.correct, 11);
});
