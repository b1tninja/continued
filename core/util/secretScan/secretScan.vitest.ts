import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  scannerBenignCorpus,
  B64,
  ALNUM,
  randomFrom,
  secretCases,
  seeded,
} from "./fixtures";
import {
  DEFAULT_RULES,
  knownValueMatcher,
  placeholderFor,
  redact,
  scanText,
  secretValuesFromEnv,
  type SecretFinding,
} from "./index";
import { collectMachineSecrets } from "./machineSecrets";

const SALT = "test-salt";
const cases = secretCases();

function ruleIds(findings: SecretFinding[]): string[] {
  return findings.map((f) => f.ruleId);
}

describe("rule set", () => {
  it("has unique ids, a description and an origin on every rule", () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of DEFAULT_RULES) {
      expect(r.description.length).toBeGreaterThan(8);
      expect(r.origin.length).toBeGreaterThan(0);
      expect(r.regex.flags).toContain("g");
    }
  });

  it("has a recall case for every rule", () => {
    const covered = new Set(cases.map((c) => c.ruleId));
    for (const r of DEFAULT_RULES) expect(covered, r.id).toContain(r.id);
  });
});

describe("recall: every rule finds its fake secret", () => {
  for (const c of cases) {
    it(`at-rest: ${c.ruleId}`, () => {
      const text = c.wrap(c.value);
      const found = scanText(text, "at-rest", { salt: SALT });
      expect(ruleIds(found), text.length > 400 ? c.ruleId : text).toContain(
        c.ruleId,
      );
      const hit = found.find((f) => f.ruleId === c.ruleId)!;
      // the finding points at exactly the secret, not its context
      expect(text.slice(hit.start, hit.end)).toBe(c.value);
    });
    it(`outbound: ${c.ruleId} is ${c.outbound ? "found" : "not run"}`, () => {
      const found = scanText(c.wrap(c.value), "outbound", { salt: SALT });
      if (c.outbound) expect(ruleIds(found)).toContain(c.ruleId);
      else expect(ruleIds(found)).not.toContain(c.ruleId);
    });
  }

  it("finds a secret in the middle of a long, noisy text", () => {
    const r = seeded(3);
    const noise = () => randomFrom(r, `${ALNUM} \n.,;(){}`, 5000);
    const c = cases.find((x) => x.ruleId === "github-pat")!;
    const text = `${noise()}\n token=${c.value}\n${noise()}`;
    expect(ruleIds(scanText(text, "outbound", { salt: SALT }))).toContain(
      "github-pat",
    );
  });
});

describe("a finding never holds the value", () => {
  it("has no field containing any fake secret, any 8-character piece of one, or the text around it", () => {
    for (const c of cases) {
      const text = c.wrap(c.value);
      const json = JSON.stringify(scanText(text, "at-rest", { salt: SALT }));
      expect(json).not.toContain(c.value);
      expect(json).not.toContain(c.value.slice(0, 8));
      expect(json).not.toContain(c.value.slice(-8));
    }
  });

  it("has exactly the documented fields", () => {
    const c = cases[0];
    const [f] = scanText(c.wrap(c.value), "outbound", { salt: SALT });
    expect(Object.keys(f).sort()).toEqual([
      "action",
      "class",
      "confidence",
      "end",
      "fingerprint",
      "kind",
      "ruleId",
      "start",
    ]);
    expect(f.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("fingerprints", () => {
  const c = cases.find((x) => x.ruleId === "github-pat")!;
  const fp = (salt: string) =>
    scanText(c.value, "outbound", { salt })[0].fingerprint;

  it("are stable for one salt and differ between salts", () => {
    expect(fp("a")).toBe(fp("a"));
    expect(fp("a")).not.toBe(fp("b"));
  });

  it("let a person allow one value without allowing the rule", () => {
    const allow = new Set([fp(SALT)]);
    expect(
      scanText(c.value, "outbound", { salt: SALT, allowFingerprints: allow }),
    ).toEqual([]);
    const other = cases.find((x) => x.ruleId === "github-oauth")!;
    expect(
      scanText(other.value, "outbound", {
        salt: SALT,
        allowFingerprints: allow,
      }),
    ).toHaveLength(1);
  });
});

describe("redact", () => {
  it("replaces each secret with a stable placeholder and keeps the context", () => {
    for (const c of cases) {
      const text = c.wrap(c.value);
      const found = scanText(text, "at-rest", { salt: SALT });
      const out = redact(text, found);
      expect(out, c.ruleId).not.toContain(c.value);
      expect(out).toMatch(/\[REDACTED:[a-z0-9-]+:[0-9a-f]{4}\]/);
      // idempotent: nothing left to find, and the placeholder is not a secret
      expect(scanText(out, "at-rest", { salt: SALT })).toEqual([]);
      // stable: the same value gets the same placeholder
      expect(redact(text, scanText(text, "at-rest", { salt: SALT }))).toBe(out);
    }
  });

  it("names the kind and four fingerprint digits", () => {
    const c = cases.find((x) => x.ruleId === "aws-access-key-id")!;
    const text = c.wrap(c.value);
    const [f] = scanText(text, "outbound", { salt: SALT });
    expect(placeholderFor(f)).toBe(
      `[REDACTED:aws-access-key:${f.fingerprint.slice(0, 4)}]`,
    );
    expect(redact(text, [f])).toBe(`aws_access_key_id = ${placeholderFor(f)}`);
  });

  it("gives equal values equal placeholders and different values different ones", () => {
    const a = cases.find((x) => x.ruleId === "github-pat")!.value;
    const b = cases.find((x) => x.ruleId === "github-oauth")!.value;
    const out = redact(
      `${a} ${a} ${b}`,
      scanText(`${a} ${a} ${b}`, "outbound", { salt: SALT }),
    );
    const marks = out.match(/\[REDACTED:[^\]]+\]/g)!;
    expect(marks).toHaveLength(3);
    expect(marks[0]).toBe(marks[1]);
    expect(marks[0]).not.toBe(marks[2]);
  });
});

describe("allowlist", () => {
  const J = (...p: string[]) => p.join("");
  it("skips documentation and placeholder values", () => {
    const texts = [
      J("AKIA", "IOSFODNN7", "EXAMPLE"),
      `aws_secret_access_key = ${J("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCY", "EXAMPLEKEY")}`,
      J("gh", "p_", "x".repeat(36)),
      J("sk", "-ant-", "x".repeat(40)),
      `API_KEY=\${OPENAI_API_KEY_VALUE}`,
      `API_KEY=<your-api-key-here>`,
      `SECRET_TOKEN=${"a".repeat(20)}`,
      J("sk", "_test_", "4eC39HqLyjWDarjtT1zdp7dc"),
    ];
    for (const t of texts) {
      expect(scanText(t, "at-rest", { salt: SALT }), t).toEqual([]);
    }
  });

  it("honours the allow marker on a line, and only on that line", () => {
    const secret = cases.find((x) => x.ruleId === "github-pat")!.value;
    const marked = `const a = "${secret}"; // secretscan:allow`;
    expect(scanText(marked, "outbound", { salt: SALT })).toEqual([]);
    expect(
      scanText(`${marked}\nconst b = "${secret}";`, "outbound", { salt: SALT }),
    ).toHaveLength(1);
    expect(
      scanText(marked, "outbound", { salt: SALT, allowMarker: "" }),
    ).toHaveLength(1);
  });
});

describe("profiles", () => {
  it("run no contextual or entropy rule outbound", () => {
    const text = cases
      .filter((c) => !c.outbound)
      .map((c) => c.wrap(c.value))
      .join("\n");
    const found = scanText(text, "outbound", { salt: SALT });
    for (const f of found) expect(f.confidence).toBe("high");
    const kinds = new Set(found.map((f) => f.class));
    expect(kinds.has("contextual")).toBe(false);
    expect(kinds.has("entropy")).toBe(false);
  });

  it("report at-rest everything outbound reports", () => {
    const text = cases.map((c) => c.wrap(c.value)).join("\n");
    const out = scanText(text, "outbound", { salt: SALT });
    const rest = scanText(text, "at-rest", { salt: SALT });
    expect(rest.length).toBeGreaterThanOrEqual(out.length);
  });
});

describe("known values (the machine's own secrets)", () => {
  // Built at runtime so no file holds a secret-looking literal.
  const canary = `${["canary", "tok"].join("-")}${randomFrom(seeded(11), ALNUM, 24)}`;
  const env = {
    PATH: "/usr/bin",
    MY_SERVICE_TOKEN: canary,
    AWS_REGION: "eu-west-1",
    CONTINUOUS_AUDIT_DIR: "/home/x/audit",
    DEBUG_SECRET: "short",
    OPENAI_API_KEY: "",
    DATABASE_URL: "postgres://app:Hunter2Hunter2@db/app",
  };

  it("takes secret-named values and not settings or short values", () => {
    const values = secretValuesFromEnv(env);
    expect(values).toContain(canary);
    expect(values).toContain(env.DATABASE_URL);
    expect(values).not.toContain("eu-west-1");
    expect(values).not.toContain("/home/x/audit");
    expect(values).not.toContain("short");
    expect(values).not.toContain("/usr/bin");
  });

  it("finds the canary under both profiles, in any shape of text, and nothing else", () => {
    const matcher = knownValueMatcher(secretValuesFromEnv(env));
    for (const profile of ["at-rest", "outbound"] as const) {
      for (const wrap of [
        (v: string) => v,
        (v: string) => `prefix ${v} suffix`,
        (v: string) => `{"headers":{"x":"${v}"}}`,
        (v: string) => `${v}${v}`,
      ]) {
        const text = wrap(canary);
        const found = scanText(text, profile, { salt: SALT, known: matcher });
        expect(found.length).toBeGreaterThanOrEqual(1);
        expect(found.every((f) => f.ruleId === "known-value")).toBe(true);
        expect(redact(text, found)).not.toContain(canary);
      }
      expect(
        scanText("no secrets here, only text of ordinary length", profile, {
          salt: SALT,
          known: matcher,
        }),
      ).toEqual([]);
    }
  });

  it("outranks a structural rule that matches the same span", () => {
    const token = cases.find((x) => x.ruleId === "github-pat")!.value;
    const matcher = knownValueMatcher([token]);
    const [f] = scanText(`x ${token} y`, "outbound", {
      salt: SALT,
      known: matcher,
    });
    expect(f.ruleId).toBe("known-value");
  });

  it("never exposes a value: not by serialisation, inspection or its own fields", () => {
    const matcher = knownValueMatcher(secretValuesFromEnv(env));
    expect(matcher.size).toBe(2);
    for (const dump of [
      JSON.stringify(matcher),
      inspect(matcher, { depth: 10, showHidden: true }),
      Object.keys(matcher).join(","),
      String(matcher.find),
    ]) {
      expect(dump).not.toContain(canary);
    }
    const found = scanText(canary, "outbound", { salt: SALT, known: matcher });
    expect(JSON.stringify(found)).not.toContain(canary);
  });

  it("ignores values under the minimum length and finds values at it", () => {
    const m = knownValueMatcher(["abc1234", "abcd1234"]);
    expect(m.size).toBe(1);
    expect(m.find("xx abcd1234 yy abc1234", SALT)).toHaveLength(1);
  });

  it("is linear enough: 1 MB of text with 200 known values", () => {
    const r = seeded(5);
    const values = Array.from({ length: 200 }, (_, i) =>
      randomFrom(r, ALNUM, 12 + (i % 30)),
    );
    const m = knownValueMatcher(values);
    const text = `${randomFrom(r, `${B64} \n`, 1_000_000)}${values[7]}`;
    const t0 = Date.now();
    const found = m.find(text, SALT);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(found).toHaveLength(1);
  });

  describe("from the well-known files", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0))
        fs.rmSync(d, { recursive: true, force: true });
    });

    it("reads aws, npm, netrc, git-credentials and ssh keys by value, and names only the source", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "secretscan-"));
      dirs.push(home);
      const r = seeded(21);
      const aws = randomFrom(r, B64, 40);
      const npm = randomFrom(r, ALNUM, 36);
      const netrc = randomFrom(r, ALNUM, 16);
      const git = randomFrom(r, ALNUM, 20);
      const keyLines = [1, 2, 3].map(() => randomFrom(r, B64, 64));
      const w = (rel: string, content: string) => {
        const f = path.join(home, ...rel.split("/"));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
      };
      w(
        ".aws/credentials",
        `[default]\naws_access_key_id = AKIA0000\naws_secret_access_key = ${aws}\n`,
      );
      w(
        ".npmrc",
        `//registry.npmjs.org/:_authToken=${npm}\nregistry=https://registry.npmjs.org/\n`,
      );
      w(".netrc", `machine example.com login me password ${netrc}\n`);
      w(".git-credentials", `https://me:${git}@github.com\n`);
      w(
        ".ssh/id_ed25519",
        `${["-----BEGIN ", "OPENSSH PRIVATE ", "KEY-----"].join("")}\n${keyLines.join("\n")}\n${["-----END ", "OPENSSH PRIVATE ", "KEY-----"].join("")}\n`,
      );
      w(
        ".ssh/id_ed25519.pub",
        `ssh-ed25519 ${randomFrom(r, B64, 68)} me@host\n`,
      );
      const { values, sources } = collectMachineSecrets({ home, env: {} });
      for (const v of [aws, npm, netrc, git, ...keyLines])
        expect(values).toContain(v);
      expect(sources.sort()).toEqual(
        [
          ".aws/credentials",
          ".git-credentials",
          ".netrc",
          ".npmrc",
          ".ssh",
        ].sort(),
      );
      expect(JSON.stringify(sources)).not.toContain(aws);
      const matcher = knownValueMatcher(values);
      const found = scanText(`oops ${aws} and ${keyLines[1]}`, "outbound", {
        salt: SALT,
        known: matcher,
      });
      expect(found.map((f) => f.ruleId)).toEqual([
        "known-value",
        "known-value",
      ]);
    });

    it("returns nothing for a home with no files", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "secretscan-"));
      dirs.push(home);
      expect(collectMachineSecrets({ home, env: {} })).toEqual({
        values: [],
        sources: [],
      });
    });
  });
});

describe("false positives", () => {
  // The stated budget. Outbound: zero findings on the benign corpus and on
  // this repository's own source and docs. At-rest: at most 2 findings per
  // 1000 corpus lines, measured below and printed when the test runs.
  const OUTBOUND_BUDGET = 0;
  const AT_REST_BUDGET_PER_1000_LINES = 2;
  const corpus = scannerBenignCorpus();

  it("outbound reports nothing on benign text", () => {
    const hits = corpus.flatMap((t) => scanText(t, "outbound", { salt: SALT }));
    expect(hits.length).toBeLessThanOrEqual(OUTBOUND_BUDGET);
  });

  it("at-rest stays inside its budget on benign text", () => {
    const hits = corpus.flatMap((t) => scanText(t, "at-rest", { salt: SALT }));
    const lines = corpus.join("\n").split("\n").length;
    const rate = (hits.length / lines) * 1000;
    console.log(
      `secretScan false positives: at-rest ${hits.length} in ${lines} lines (${rate.toFixed(2)} per 1000); rules: ${[...new Set(ruleIds(hits))].join(",") || "none"}`,
    );
    expect(rate).toBeLessThanOrEqual(AT_REST_BUDGET_PER_1000_LINES);
  });

  it("measured on this repository's own source and docs", () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const files: string[] = [];
    for (const dir of [
      "core/util",
      "core/tools",
      "docs/ide-extensions/agent",
      "plans",
    ]) {
      const abs = path.join(root, dir);
      if (!fs.existsSync(abs)) continue;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.isFile() && /\.(ts|md|mdx)$/.test(e.name))
          files.push(path.join(abs, e.name));
      }
    }
    let lines = 0;
    const outbound: string[] = [];
    const atRest: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      lines += text.split("\n").length;
      for (const x of scanText(text, "outbound", { salt: SALT })) {
        outbound.push(`${path.relative(root, f)}:${x.ruleId}`);
      }
      for (const x of scanText(text, "at-rest", { salt: SALT })) {
        atRest.push(`${path.relative(root, f)}:${x.ruleId}`);
      }
    }
    console.log(
      `secretScan repo scan: ${files.length} files, ${lines} lines; outbound ${outbound.length}; at-rest ${atRest.length} (${((atRest.length / lines) * 1000).toFixed(2)} per 1000 lines): ${atRest.slice(0, 12).join(" ")}`,
    );
    expect(files.length).toBeGreaterThan(50);
    expect(outbound).toEqual([]);
    expect((atRest.length / lines) * 1000).toBeLessThanOrEqual(
      AT_REST_BUDGET_PER_1000_LINES,
    );
  });
});

describe("robustness", () => {
  it("handles empty text, huge lines and pathological input in bounded time", () => {
    expect(scanText("", "at-rest")).toEqual([]);
    const r = seeded(9);
    const blob = randomFrom(r, B64, 300_000);
    const evil = `${"key".repeat(50_000)}`;
    const marks = `${"-----BEGIN PRIVATE KEY-----\n".repeat(2000)}`;
    const t0 = Date.now();
    for (const t of [
      blob,
      evil,
      marks,
      "=".repeat(100_000),
      "a_".repeat(100_000),
    ]) {
      scanText(t, "at-rest", { salt: SALT });
    }
    expect(Date.now() - t0).toBeLessThan(20_000);
  });
});
