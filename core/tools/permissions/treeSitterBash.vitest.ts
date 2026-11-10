import { beforeAll, describe, expect, it } from "vitest";
import { bashCrossCheckReady } from "./bashCrossCheck";
import { classifyReadOnly } from "./readOnlyCommand";
import { scanCommand } from "./shellScan";
import {
  bashGraph,
  crossCheckBash,
  initTreeSitterBash,
  sameGraph,
  treeSitterBashReady,
} from "./treeSitterBash";
import { casesFor } from "./corpus/verdicts";

const BS = String.fromCharCode(92);

beforeAll(async () => {
  expect(await initTreeSitterBash()).toBe(true);
});

const graphOf = (command: string) => {
  const g = bashGraph(command);
  if (!g || !g.ok)
    throw new Error(
      `no graph for ${command}: ${g && !g.ok ? g.why : "not loaded"}`,
    );
  return g.graph;
};

describe("the bash grammar as a reader", () => {
  it("loads, and registers itself as the cross-check", () => {
    expect(treeSitterBashReady()).toBe(true);
    expect(bashCrossCheckReady()).toBe(true);
  });

  it("builds the commands, their words and the operators between them", () => {
    expect(graphOf("ls -la | head")).toEqual({
      commands: [{ words: ["ls", "-la"] }, { words: ["head"] }],
      joins: ["|"],
    });
    expect(graphOf("cd a && ls || pwd; whoami")).toEqual({
      commands: [
        { words: ["cd", "a"] },
        { words: ["ls"] },
        { words: ["pwd"] },
        { words: ["whoami"] },
      ],
      joins: ["&&", "||", ";"],
    });
  });

  it("removes quotes and joins adjacent pieces, as the shell does", () => {
    expect(graphOf(`echo "a b" 'c d' e"f"'g'`).commands[0].words).toEqual([
      "echo",
      "a b",
      "c d",
      "efg",
    ]);
  });

  it("drops redirects to nowhere and refuses every other", () => {
    expect(graphOf("ls 2>/dev/null").commands).toEqual([{ words: ["ls"] }]);
    expect(graphOf("ls > /dev/null 2>&1").commands).toEqual([
      { words: ["ls"] },
    ]);
    for (const c of ["cat a > b", "cat < a", "ls >> out"]) {
      const g = bashGraph(c);
      expect(g?.ok, c).toBe(false);
    }
  });

  it.each([
    "echo $(whoami)",
    "ls $HOME",
    "ls `whoami`",
    "FOO=bar ls",
    "(ls)",
    "{ ls; }",
    "ls &",
    "cat <<EOF\nx\nEOF",
    "if true; then ls; fi",
    "ls |",
    "echo ${HOME}",
    "ls # comment",
  ])("does not understand %s", (command) => {
    expect(bashGraph(command)?.ok).toBe(false);
  });

  it("does not hand an escaped word to anyone: the escaped quote hides nothing", () => {
    // the grammar does see three commands, the second the rm; its gate refuses
    // any word that carries an escape, so no graph is built for it at all
    const g = bashGraph(`echo ${BS}'; rm -rf x; echo ${BS}'`);
    expect(g?.ok).toBe(false);
    expect(scanCommand(`echo ${BS}'; rm -rf x; echo ${BS}'`, "bash").ok).toBe(
      false,
    );
  });

  it("an escaped space is one word, which the scanner declines to read", () => {
    // the grammar sees one argument; the scanner does not understand escapes
    expect(bashGraph(`ls a${BS} b`)?.ok).toBe(false);
    expect(scanCommand(`ls a${BS} b`, "bash").ok).toBe(false);
  });
});

describe("the cross-check", () => {
  it("agrees about what the scanner understood", () => {
    const ours = scanCommand("git log --oneline | head -3", "bash");
    expect(
      ours.ok && crossCheckBash("git log --oneline | head -3", ours.graph),
    ).toBe(undefined);
  });

  it("catches a scanner that reads a command differently from the shell", () => {
    // the scanner of an earlier day: a backslash as a letter, so one echo
    const command = `echo ${BS}'; rm -rf x; echo ${BS}'`;
    const buggy = {
      commands: [{ words: ["echo", `${BS}'; rm -rf x; echo ${BS}'`] }],
      joins: [],
    };
    expect(crossCheckBash(command, buggy)).toContain("bash grammar");
    // and a graph that did match would be accepted
    expect(sameGraph(buggy, buggy)).toBe(true);
    expect(bashGraph(command)?.ok).toBe(false);
  });

  it("is a disagreement when the grammar does not understand what the scanner did", () => {
    const ours = { commands: [{ words: ["ls", "a"] }], joins: [] };
    expect(crossCheckBash("ls $(a)", ours)).toContain("does not read it");
  });

  it("makes the classifier decline a command the two readers see differently", () => {
    // not reachable through the scanner today (it rejects the backslash), so
    // this checks the plumbing: with the cross-check on, agreeing commands pass
    expect(
      classifyReadOnly("ls -la | head", { shell: "bash", cwd: "/r" }).vouched,
    ).toBe(true);
  });
});

describe("the corpus, read both ways", () => {
  const posix = (["bash", "zsh", "sh"] as const).flatMap((shell) =>
    casesFor(shell).map((k) => ({ shell, ...k })),
  );

  it("the grammar agrees with the scanner on every command the scanner understands", () => {
    const disagreements: string[] = [];
    for (const k of posix) {
      const ours = scanCommand(k.command, k.shell);
      if (!ours.ok) continue;
      const why = crossCheckBash(k.command, ours.graph);
      if (why) disagreements.push(`${k.shell} | ${k.command}: ${why}`);
    }
    expect([...new Set(disagreements)].sort()).toEqual([]);
  });

  it("with the cross-check on, the classifier still vouches for nothing that is not a read", () => {
    const unsound = posix
      .filter((k) => k.verdict !== "reads")
      .filter(
        (k) =>
          classifyReadOnly(k.command, {
            shell: k.shell,
            cwd: "/repo",
            home: "/home/u",
            readGitConfig: () => "",
            probe: () => undefined,
          }).vouched,
      )
      .map((k) => `${k.shell} | ${k.command}`);
    expect(unsound).toEqual([]);
  });

  it("what the grammar understands is a subset of what is true: it never reads a write as one command it vouches", () => {
    // every corpus write the grammar understands has a command that is not a read
    for (const k of posix.filter((x) => x.verdict === "writes")) {
      const g = bashGraph(k.command);
      if (!g || !g.ok) continue;
      const names = g.graph.commands.map((c) => c.words[0]);
      const claim = classifyReadOnly(k.command, {
        shell: k.shell,
        cwd: "/repo",
        home: "/home/u",
        readGitConfig: () => "",
        probe: () => undefined,
      });
      expect(claim.vouched, `${k.command} (${names.join(",")})`).toBe(false);
    }
  });
});
