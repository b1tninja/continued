/**
 * Edit failures of the shapes small and mid-size models produce, with the
 * expected outcome of recoverMatch. SYNTHESISED, not captured from a run:
 * each case is built from a failure mode named in plans/edit-formats.md
 * (drifted indentation, CRLF files, truncated or elided old_string, escaped
 * quotes, ambiguous repeats, typos). Replace entries with captured ones as the
 * bench records them.
 */
export interface EditFailureCase {
  id: string;
  /** The failure mode this case stands for. */
  mode: string;
  file: string;
  oldString: string;
  newString: string;
  expect:
    | { kind: "applies"; strategy: string; result: string }
    | { kind: "error"; reason: "notFound" | "ambiguous"; includes: string[] };
}

const TS = [
  "export function total(items: Item[]) {",
  "  let sum = 0;",
  "  for (const it of items) {",
  "    sum += it.price * it.qty;",
  "  }",
  "  return sum;",
  "}",
  "",
].join("\n");

export const editFailureCorpus: EditFailureCase[] = [
  {
    id: "indent-too-shallow",
    mode: "block copied at the wrong indentation",
    file: "class A {\n    run() {\n        a();\n        b();\n    }\n}\n",
    oldString: "run() {\n    a();\n    b();\n}",
    newString: "run() {\n    a();\n    c();\n    b();\n}",
    expect: {
      kind: "applies",
      strategy: "indentation",
      result:
        "class A {\n    run() {\n        a();\n        c();\n        b();\n    }\n}\n",
    },
  },
  {
    id: "indent-too-deep",
    mode: "block copied at the wrong indentation",
    file: "function f() {\n  x();\n  y();\n}\n",
    oldString: "    x();\n    y();",
    newString: "    x();\n    z();",
    expect: {
      kind: "applies",
      strategy: "indentation",
      result: "function f() {\n  x();\n  z();\n}\n",
    },
  },
  {
    id: "crlf-file-lf-old",
    mode: "CRLF file, model sends LF",
    file: "a\r\nb\r\nc\r\n",
    oldString: "a\nb",
    newString: "a\nB",
    expect: {
      kind: "applies",
      strategy: "lineEndings",
      result: "a\r\nB\r\nc\r\n",
    },
  },
  {
    id: "trailing-ws-in-file",
    mode: "file has trailing spaces the model dropped",
    file: "const a = 1;   \nconst b = 2;\t\n",
    oldString: "const a = 1;\nconst b = 2;",
    newString: "const a = 1;\nconst b = 3;",
    expect: {
      kind: "applies",
      strategy: "whitespace",
      result: "const a = 1;\nconst b = 3;\n",
    },
  },
  {
    id: "collapsed-spaces",
    mode: "runs of spaces collapsed inside a line",
    file: "const  table = {  a: 1 };\nuse(table);\n",
    oldString: "const table = { a: 1 };\nuse(table);",
    newString: "const table = { a: 2 };\nuse(table);",
    expect: {
      kind: "applies",
      strategy: "whitespace",
      result: "const table = { a: 2 };\nuse(table);\n",
    },
  },
  {
    id: "anchored-middle-drift",
    mode: "interior line paraphrased, ends exact",
    file: TS,
    oldString:
      "  for (const it of items) {\n    sum += it.price * it.qty + 0;\n  }",
    newString:
      "  for (const it of items) {\n    sum += it.qty * it.price * 2;\n  }",
    expect: {
      kind: "applies",
      strategy: "anchored",
      result: TS.replace(
        "    sum += it.price * it.qty;",
        "    sum += it.qty * it.price * 2;",
      ),
    },
  },
  {
    id: "typo-in-one-line",
    mode: "one character wrong in a long line",
    file: "const message = computeGreeting(user.firstName, user.lastName);\nlog(message);\n",
    oldString:
      "const mesage = computeGreeting(user.firstName, user.lastName);\nlog(message);",
    newString: "const message = greet(user);\nlog(message);",
    expect: {
      kind: "applies",
      strategy: "fuzzy",
      result: "const message = greet(user);\nlog(message);\n",
    },
  },
  {
    id: "ambiguous-after-normalising",
    mode: "two identical blocks at different indentation",
    file: "if (a) {\n  go();\n}\nif (b) {\n    go();\n}\n",
    oldString: "go();",
    newString: "stop();",
    // exact "go();" occurs, so this case reaches recoverMatch with a block
    // that only matches modulo indentation in two places.
    expect: { kind: "error", reason: "ambiguous", includes: ["2 places"] },
  },
  {
    id: "elided-placeholder",
    mode: "model writes ... for the lines it skipped",
    file: TS,
    oldString:
      "export function total(items: Item[]) {\n  // ... existing code ...\n  return sum;\n}",
    newString: "export function total() {}",
    expect: {
      kind: "error",
      reason: "notFound",
      includes: ["old_string line 2", "placeholder"],
    },
  },
  {
    id: "escaped-quotes",
    mode: "quotes escaped inside a JSON argument and left that way",
    file: 'const s = "hello";\nconst t = "world";\n',
    oldString: 'const s = \\"hello\\";',
    newString: 'const s = "hi";',
    expect: {
      kind: "error",
      reason: "notFound",
      includes: ["old_string line 1", "plain quote"],
    },
  },
  {
    id: "literal-backslash-n",
    mode: "newlines sent as the two characters backslash n",
    file: "a = 1\nb = 2\n",
    oldString: "a = 1\\nb = 2",
    newString: "a = 1\nb = 3",
    expect: {
      kind: "error",
      reason: "notFound",
      includes: ["backslash-n"],
    },
  },
  {
    id: "truncated-old-string-tail-wrong",
    mode: "old_string cut off mid-token and closed wrongly",
    file: TS,
    oldString: "  for (const it of items) {\n    sum += it.pri",
    newString: "x",
    expect: {
      kind: "error",
      reason: "notFound",
      includes: ["old_string line 2", "file line 4"],
    },
  },
  {
    id: "line-number-prefix",
    mode: "line numbers from a file view copied in",
    file: "alpha();\nbeta();\n",
    oldString: "1: alpha();\n2: beta();",
    newString: "x();",
    expect: {
      kind: "error",
      reason: "notFound",
      includes: ["line numbers"],
    },
  },
  {
    id: "wrong-file-entirely",
    mode: "old_string from another file",
    file: "one\ntwo\nthree\n",
    oldString: "completely::unrelated(text);\nmore::unrelated(text);",
    newString: "x",
    expect: { kind: "error", reason: "notFound", includes: ["No region"] },
  },
];
