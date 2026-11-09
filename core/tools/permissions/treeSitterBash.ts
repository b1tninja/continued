import * as path from "node:path";
import Parser from "web-tree-sitter";
import { setBashCrossCheck } from "./bashCrossCheck";
import type {
  CommandGraph,
  GraphCommand,
  JoinOperator,
  ScanResult,
} from "./shellScan";

/**
 * The bash grammar as a second reader of a POSIX command (plans/command-analysis.md,
 * P2, decision D1). It builds the same graph as the strict scanner from the
 * syntax tree, through our own gate: only commands, pipelines, lists and
 * redirects to nowhere, with words, quoted strings and plain concatenations
 * for arguments. Anything else (an expansion, a substitution, a group, an
 * assignment, a heredoc, a parse error) is not understood.
 */

let parser: Parser | undefined;
let loading: Promise<boolean> | undefined;

function defaultWasmPath(): string {
  return path.join(
    process.env.NODE_ENV === "test" ? process.cwd() : __dirname,
    ...(process.env.NODE_ENV === "test"
      ? ["node_modules", "tree-sitter-wasms", "out"]
      : ["tree-sitter-wasms"]),
    "tree-sitter-bash.wasm",
  );
}

/**
 * Loads the bash grammar and registers the cross-check. Safe to call more than
 * once and never throws: false means no second reader, and the strict scanner
 * stands alone.
 */
export function initTreeSitterBash(wasmPath?: string): Promise<boolean> {
  loading ??= (async () => {
    try {
      await Parser.init();
      const language = await Parser.Language.load(
        wasmPath ?? defaultWasmPath(),
      );
      const p = new Parser();
      p.setLanguage(language);
      parser = p;
      setBashCrossCheck(crossCheckBash);
      return true;
    } catch (e) {
      console.debug("The bash grammar could not be loaded", e);
      return false;
    }
  })();
  return loading;
}

export function treeSitterBashReady(): boolean {
  return parser !== undefined;
}

const DISCARD = /^(2?>\s*\/dev\/null|2>&1)$/;

type Walked =
  | { ok: true; commands: GraphCommand[]; joins: JoinOperator[] }
  | { ok: false; why: string };

const bad = (why: string): Walked => ({ ok: false, why });

/** A word, string or number as the text the shell hands the program. */
function wordText(node: Parser.SyntaxNode): string | undefined {
  switch (node.type) {
    case "word":
    case "number":
      // A backslash is an escape the shell removes: not the text as written
      return node.text.includes("\\") ? undefined : node.text;
    case "raw_string":
      return node.text.slice(1, -1);
    case "string": {
      // Only plain text inside the quotes: no expansion, no substitution
      if (node.namedChildren.some((c) => c.type !== "string_content")) {
        return undefined;
      }
      const body = node.text.slice(1, -1);
      return body.includes("\\") ? undefined : body;
    }
    case "concatenation": {
      let out = "";
      for (const part of node.namedChildren) {
        const t = wordText(part);
        if (t === undefined) return undefined;
        out += t;
      }
      return out;
    }
    case "command_name": {
      const inner = node.namedChildren[0];
      return inner ? wordText(inner) : undefined;
    }
    default:
      return undefined;
  }
}

function walkCommand(node: Parser.SyntaxNode): Walked {
  const words: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "variable_assignment") {
      return bad("an environment prefix");
    }
    const text = wordText(child);
    if (text === undefined) {
      return bad(`${child.type} is not understood`);
    }
    words.push(text);
  }
  if (words.length === 0) return bad("an empty command");
  return { ok: true, commands: [{ words }], joins: [] };
}

function append(a: Walked, join: JoinOperator, b: Walked): Walked {
  if (!a.ok) return a;
  if (!b.ok) return b;
  return {
    ok: true,
    commands: [...a.commands, ...b.commands],
    joins: [...a.joins, join, ...b.joins],
  };
}

/** The commands under a node, in order, with the operators between them. */
function walk(node: Parser.SyntaxNode): Walked {
  switch (node.type) {
    case "command":
      return walkCommand(node);
    case "redirected_statement": {
      const body = node.childForFieldName("body");
      if (!body) return bad("a redirect with no command");
      // Everything beside the body is a redirect, and only a discard is understood
      for (const r of node.namedChildren) {
        if (r.startIndex === body.startIndex && r.type === body.type) continue;
        if (r.type !== "file_redirect" || !DISCARD.test(r.text.trim())) {
          return bad("a redirect that is not to nowhere");
        }
      }
      return walk(body);
    }
    case "pipeline":
    case "list":
    case "program": {
      let acc: Walked | undefined;
      let pending: JoinOperator | undefined;
      for (const child of node.children) {
        if (child.type === "|" || child.type === "&&" || child.type === "||") {
          pending = child.type;
          continue;
        }
        if (child.type === ";" || child.type === "\n") {
          pending = ";";
          continue;
        }
        if (!child.isNamed) {
          return bad(`"${child.type}" is not understood`);
        }
        if (child.type === "comment") return bad("a comment");
        const next = walk(child);
        acc = acc ? append(acc, pending ?? ";", next) : next;
        pending = undefined;
      }
      return acc ?? bad("an empty command");
    }
    default:
      return bad(`${node.type} is not understood`);
  }
}

/** What the bash grammar makes of a command, or undefined when it is not loaded. */
export function bashGraph(command: string): ScanResult | undefined {
  if (!parser) return undefined;
  const tree = parser.parse(command);
  try {
    if (tree.rootNode.hasError()) {
      return { ok: false, why: "the bash grammar reports a syntax error" };
    }
    const walked = walk(tree.rootNode);
    if (!walked.ok) return { ok: false, why: walked.why };
    return {
      ok: true,
      graph: { commands: walked.commands, joins: walked.joins },
    };
  } finally {
    tree.delete();
  }
}

/** Whether two graphs are the same commands joined by the same operators. */
export function sameGraph(a: CommandGraph, b: CommandGraph): boolean {
  return (
    a.commands.length === b.commands.length &&
    a.joins.length === b.joins.length &&
    a.joins.every((j, i) => j === b.joins[i]) &&
    a.commands.every(
      (c, i) =>
        c.words.length === b.commands[i].words.length &&
        c.words.every((w, k) => w === b.commands[i].words[k]),
    )
  );
}

/**
 * Why the bash grammar does not agree with the strict scanner about a command
 * the scanner understood, or undefined when it agrees (or is not loaded).
 */
export function crossCheckBash(
  command: string,
  ours: CommandGraph,
): string | undefined {
  const theirs = bashGraph(command);
  if (!theirs) return undefined;
  if (!theirs.ok) {
    return `the bash grammar does not read it the way the scanner does (${theirs.why})`;
  }
  return sameGraph(ours, theirs.graph)
    ? undefined
    : "the bash grammar reads it as different commands than the scanner does";
}
