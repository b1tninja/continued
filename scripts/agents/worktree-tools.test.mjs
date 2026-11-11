import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrap } from "./worktree-bootstrap.mjs";
import { assess, reap } from "./worktree-reap.mjs";
import { dirSize, isLink, removeTree } from "./worktree-lib.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "wtt-"));
const link = (target, p) => symlinkSync(target, p, "junction"); // junction on Windows, dir symlink elsewhere

/** A "sibling install" that must survive anything done to a link pointing at it. */
function makeTarget(dir) {
  mkdirSync(join(dir, "prettier"), { recursive: true });
  writeFileSync(join(dir, "prettier", "package.json"), '{"version":"3.5.3"}');
  return dir;
}

test("removeTree removes a junction/symlink link-only and leaves the target intact", () => {
  const d = tmp();
  const target = makeTarget(join(d, "sibling", "node_modules"));
  const wt = join(d, "wt");
  mkdirSync(join(wt, "gui"), { recursive: true });
  link(target, join(wt, "gui", "node_modules"));
  assert.ok(isLink(join(wt, "gui", "node_modules")));
  removeTree(join(wt, "gui", "node_modules"));
  assert.equal(existsSync(join(wt, "gui", "node_modules")), false);
  assert.ok(existsSync(join(target, "prettier", "package.json")));
  // a link nested inside a real node_modules is unlinked, not followed
  mkdirSync(join(wt, "core", "node_modules"), { recursive: true });
  link(target, join(wt, "core", "node_modules", "dep"));
  removeTree(join(wt, "core", "node_modules"));
  assert.equal(existsSync(join(wt, "core", "node_modules")), false);
  assert.ok(existsSync(join(target, "prettier", "package.json")));
  rmSync(d, { recursive: true, force: true });
});

test("dirSize does not follow links", () => {
  const d = tmp();
  const target = makeTarget(join(d, "t"));
  writeFileSync(join(target, "big"), "x".repeat(100000));
  mkdirSync(join(d, "w"));
  link(target, join(d, "w", "nm"));
  assert.ok(dirSize(join(d, "w")) < 50000);
  removeTree(join(d, "w", "nm"));
  rmSync(d, { recursive: true, force: true });
});

function lockWith(dir, versions) {
  const packages = {};
  for (const [k, v] of Object.entries(versions))
    packages[`node_modules/${k}`] = { version: v };
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages }));
}

test("bootstrap refuses a node_modules junction and never runs npm there", () => {
  const d = tmp();
  const target = makeTarget(join(d, "sibling", "node_modules"));
  const wt = join(d, "wt");
  mkdirSync(wt);
  lockWith(wt, { prettier: "3.9.10" });
  link(target, join(wt, "node_modules"));
  const calls = [];
  const logs = [];
  const r = bootstrap(wt, ["root"], {
    run: (...a) => (calls.push(a), { status: 0, stdout: "", stderr: "" }),
    log: (m) => logs.push(m),
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  assert.match(logs.join("\n"), /REFUSED \.: .*symlink\/junction/);
  assert.ok(existsSync(join(target, "prettier", "package.json")));
  rmSync(d, { recursive: true, force: true });
});

test("bootstrap installs requested sets only, verifies tool versions against the lock", () => {
  const d = tmp();
  for (const s of ["core", "gui"]) {
    mkdirSync(join(d, s));
    lockWith(join(d, s), { eslint: "10.14.0" });
  }
  lockWith(d, { prettier: "3.9.10" });
  const ran = [];
  const mk = (ver) => (cmd, args, opts) => {
    ran.push({ args, cwd: opts.cwd });
    const nm = join(opts.cwd, "node_modules");
    for (const t of ["eslint", "prettier"]) {
      mkdirSync(join(nm, t), { recursive: true });
      writeFileSync(
        join(nm, t, "package.json"),
        JSON.stringify({ version: ver[t] }),
      );
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const ok = bootstrap(d, ["core"], {
    run: mk({ eslint: "10.14.0", prettier: "3.9.10" }),
    cache: "/c",
    log: () => {},
  });
  assert.equal(ok.ok, true);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].cwd, join(d, "core"));
  assert.deepEqual(ran[0].args.slice(0, 2), ["ci", "--ignore-scripts"]);
  assert.ok(ran[0].args.includes("/c"));
  assert.ok(ok.bytes > 0);
  const bad = bootstrap(d, ["gui"], {
    run: mk({ eslint: "9.0.0", prettier: "3.9.10" }),
    log: () => {},
  });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /eslint 9.0.0 != 10.14.0/);
  assert.throws(() => bootstrap(d, ["nope"], { log: () => {} }), /unknown set/);
  rmSync(d, { recursive: true, force: true });
});

/** Fake git and gh. `repo` describes each branch; calls are recorded. */
function fakeRun(root, branches, { gh = true, removed = [] } = {}) {
  return (cmd, args, opts = {}) => {
    const out = (stdout = "", status = 0) => ({ status, stdout, stderr: "" });
    if (cmd === "git") {
      const a = args.join(" ");
      if (a === "rev-parse --show-toplevel") return out(join(root, "main"));
      if (a === "worktree list --porcelain")
        return out(
          [`worktree ${join(root, "main")}`, "branch refs/heads/main", ""]
            .concat(
              Object.entries(branches).flatMap(([b, v]) => [
                `worktree ${v.path}`,
                v.detached ? "detached" : `branch refs/heads/${b}`,
                "",
              ]),
            )
            .join("\n"),
        );
      if (a === "status --porcelain") {
        const b = Object.values(branches).find((v) => v.path === opts.cwd);
        return out(b?.dirty ? " M f\n" : "");
      }
      let m;
      if ((m = a.match(/^rev-parse --abbrev-ref (.+)@\{upstream\}$/)))
        return branches[m[1]].upstream ? out(`origin/${m[1]}`) : out("", 1);
      if (
        (m = a.match(
          /^rev-parse --verify --quiet refs\/remotes\/origin\/(.+)$/,
        ))
      )
        return branches[m[1]].remote ? out("x") : out("", 1);
      if ((m = a.match(/^rev-list --count origin\/(.+)\.\.(.+)$/)))
        return out(String(branches[m[2]].ahead ?? 0));
      if ((m = a.match(/^rev-parse (.+)$/)))
        return out(branches[m[1]]?.head ?? "h0");
      if (a.startsWith("merge-base --is-ancestor"))
        return out("", branches[args[2]].ancestor ? 0 : 1);
      if (args[0] === "worktree" && args[1] === "remove") {
        removed.push(args[2]);
        rmSync(args[2], { recursive: true, force: true });
        return out();
      }
    }
    if (cmd === "gh") {
      if (!gh) return { status: 1, stdout: "", stderr: "gh: not found" };
      const b = args[args.indexOf("--head") + 1];
      return out((branches[b].pr ?? []).join("\n"));
    }
    return out("", 0); // process check: nothing open
  };
}

function mkWt(root, name) {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  return p;
}

test("assess: safe only when pushed, PR merged/closed, clean", () => {
  const root = tmp();
  mkdirSync(join(root, "main"));
  const mk = (extra) => ({
    path: mkWt(root, "x" + Math.random()),
    upstream: true,
    ...extra,
  });
  const branches = {
    ok: mk({ pr: ["MERGED h0"] }),
    closed: mk({ pr: ["CLOSED h0"] }),
    open: mk({ pr: ["OPEN h0"] }),
    nopr: mk({ pr: [] }),
    ahead: mk({ pr: ["MERGED h0"], ahead: 2 }),
    dirty: mk({ pr: ["MERGED h0"], dirty: true }),
    gone: { path: mkWt(root, "gone"), pr: ["MERGED h0"], head: "h0" },
    goneDiff: { path: mkWt(root, "gone2"), pr: ["MERGED hX"], head: "h0" },
  };
  const run = fakeRun(root, branches);
  const top = join(root, "main");
  const res = {};
  for (const [b, v] of Object.entries(branches))
    res[b] = assess({ path: v.path, branch: b }, { run, top });
  assert.equal(res.ok.safe, true);
  assert.equal(res.closed.safe, true);
  assert.match(res.open.reasons.join(), /PR open/);
  assert.match(res.nopr.reasons.join(), /no PR/);
  assert.match(res.ahead.reasons.join(), /2 unpushed/);
  assert.match(res.dirty.reasons.join(), /uncommitted/);
  assert.equal(res.gone.safe, true); // remote branch deleted, PR head equals local HEAD
  assert.equal(res.goneDiff.safe, false);
  assert.equal(assess({ path: root }, { run, top }).safe, false); // detached
  rmSync(root, { recursive: true, force: true });
});

test("assess without gh falls back to ancestry and warns", () => {
  const root = tmp();
  mkdirSync(join(root, "main"));
  const branches = {
    a: { path: mkWt(root, "a"), upstream: true, ancestor: true },
    b: { path: mkWt(root, "b"), upstream: true, ancestor: false },
  };
  const run = fakeRun(root, branches, { gh: false });
  const top = join(root, "main");
  const a = assess({ path: branches.a.path, branch: "a" }, { run, top });
  const b = assess({ path: branches.b.path, branch: "b" }, { run, top });
  assert.equal(a.safe, true);
  assert.match(a.warnings.join(), /gh unavailable/);
  assert.equal(b.safe, false);
  rmSync(root, { recursive: true, force: true });
});

test("reap: dry run deletes nothing; --apply unlinks junctions link-only and removes safe worktrees", () => {
  const root = tmp();
  mkdirSync(join(root, "main"));
  const target = makeTarget(join(root, "sibling-install"));
  const safeWt = mkWt(root, "wt-safe");
  mkdirSync(join(safeWt, "gui"), { recursive: true });
  link(target, join(safeWt, "gui", "node_modules"));
  mkdirSync(join(safeWt, "node_modules", "p"), { recursive: true });
  writeFileSync(join(safeWt, "node_modules", "p", "big"), "x".repeat(5000));
  const keepWt = mkWt(root, "wt-keep");
  const removed = [];
  const branches = {
    safe: { path: safeWt, upstream: true, pr: ["MERGED h0"] },
    keep: { path: keepWt, upstream: true, pr: ["OPEN h0"] },
  };
  const run = fakeRun(root, branches, { removed });
  const logs = [];
  const base = {
    root,
    run,
    cwd: join(root, "main"),
    log: (m) => logs.push(m),
    checkProcs: false,
  };

  const dry = reap({ ...base });
  assert.equal(dry.rows.length, 2);
  assert.match(logs.join("\n"), /DRY RUN.*2 worktree\(s\), 1 safe, 1 keep/);
  assert.equal(removed.length, 0);
  assert.ok(existsSync(join(safeWt, "node_modules", "p", "big")));

  // a path outside --root is ignored
  assert.equal(reap({ ...base, root: join(root, "elsewhere") }).rows.length, 0);

  const applied = reap({ ...base, apply: true });
  assert.deepEqual(removed, [safeWt]);
  assert.ok(applied.freed >= 5000);
  assert.ok(
    existsSync(join(target, "prettier", "package.json")),
    "link target must survive",
  );
  assert.equal(
    readFileSync(join(target, "prettier", "package.json"), "utf8"),
    '{"version":"3.5.3"}',
  );
  assert.ok(existsSync(keepWt));
  rmSync(root, { recursive: true, force: true });
});
