import { describe, expect, it } from "vitest";
import {
  clipMasked,
  hashMasked,
  maskDeep,
  maskForAudit,
  maskText,
} from "./mask";
import { benignCorpus, secretCases } from "../../../util/secretScan/fixtures";

// Built from pieces so no real-looking credential sits in the source.
const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
const ghp = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const sk = "sk-" + "proj-" + "abcdefghijklmnopqrstuvwx";
const ant = "sk-ant-" + "api03-abcdefghijklmnop1234";
const slack = "xoxb-" + "1234567890-abcdefghij";
const google = "AIza" + "SyA1234567890abcdefghijklmnopqrstuv";
const jwt =
  "eyJhbGciOiJIUzI1NiJ9" +
  ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
  ".dozjgNryP4J3jVmNHl0w5N";
const pem =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";

/** Values that must never reach the file, each in the form a command or argument gives it. */
const LEAKS: [string, string, string][] = [
  ["aws key", `aws s3 ls --profile x # ${aws}`, aws],
  ["github token", `git clone https://x:${ghp}@github.com/a/b`, ghp],
  ["openai-style key", `curl -d key=${sk} https://example.test`, sk],
  ["anthropic key", `echo ${ant}`, ant],
  ["slack token", `curl -H 'X-Slack: ${slack}'`, slack],
  ["google key", `curl "https://example.test/?k=${google}"`, google],
  ["jwt", `echo ${jwt} | cut -d. -f2`, jwt],
  ["pem block", `cat <<EOF\n${pem}\nEOF`, "MIIEowIBAAKCAQEA"],
  [
    "bearer header",
    `curl -H "Authorization: Bearer hunter2hunter2" https://example.test`,
    "hunter2hunter2",
  ],
  [
    "basic header",
    `curl -H 'authorization: Basic dXNlcjpwYXNz' https://example.test`,
    "dXNlcjpwYXNz",
  ],
  [
    "cookie header",
    `curl -H "Cookie: sid=abc123; theme=dark" https://example.test`,
    "abc123",
  ],
  ["api key header", `curl -H "x-api-key: zzzz9999yyyy" u`, "zzzz9999yyyy"],
  [
    "url password",
    `git clone https://bob:s3cr3tpass@host.test/r.git`,
    "s3cr3tpass",
  ],
  ["env assign", `API_KEY=abc999def ./run.sh`, "abc999def"],
  [
    "quoted env assign",
    `export DB_PASSWORD="two words here"`,
    "two words here",
  ],
  [
    "aws secret var",
    `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG ./x`,
    "wJalrXUtnFEMIK7MDENG",
  ],
  ["flag value", `mysql --password hunter3hunter3 -u root`, "hunter3hunter3"],
  ["flag equals", `tool --api-key=qqq111rrr222`, "qqq111rrr222"],
  ["json field", `{"path":"a","api_key":"leaky-value-1"}`, "leaky-value-1"],
  ["json password", `{"password":"p@ss w0rd"}`, "p@ss w0rd"],
  [
    "query token",
    `curl "https://example.test/x?id=1&access_token=tok-8765&b=2"`,
    "tok-8765",
  ],
];

describe("maskText", () => {
  it.each(LEAKS)("masks %s", (_name, text, secret) => {
    const { text: out, kinds } = maskText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("«masked:");
    expect(kinds.length).toBeGreaterThan(0);
  });

  it("keeps the kind and the surrounding text readable", () => {
    expect(maskText("API_KEY=abc999def ./run.sh").text).toBe(
      "API_KEY=«masked:secret-variable» ./run.sh",
    );
    expect(maskText(`mysql --password hunter3hunter3 -u root`).text).toBe(
      "mysql --password «masked:secret-flag» -u root",
    );
    expect(maskText("curl -H 'Authorization: Bearer abc.def'").text).toBe(
      "curl -H 'Authorization: Bearer «masked:header»'",
    );
  });

  // Things that look secret-ish and must survive, so the list stays useful.
  const KEEP = [
    "git checkout 3f786850e387550fdab836ed7e6dc881de23001b",
    "git log --format=%H -n 5",
    "kubectl get pod 123e4567-e89b-12d3-a456-426614174000",
    "KEYBOARD_LAYOUT=us ./start",
    "ls src/keys.ts src/tokenizer.ts",
    "npm test -- --grep password",
    "curl https://example.test/docs?page=2&sort=name",
    "git clone https://github.com/a/b.git",
    "echo $API_KEY",
    "ssh -i ~/.ssh/id_ed25519 host",
  ];
  it.each(KEEP)("leaves %s alone", (text) => {
    expect(maskText(text).text).toBe(text);
  });

  it("is idempotent", () => {
    for (const [, text] of LEAKS) {
      const once = maskText(text).text;
      expect(maskText(once).text).toBe(once);
    }
  });

  it("reports each kind once", () => {
    const { kinds } = maskText("A_TOKEN=1 B_TOKEN=2 C_SECRET=3");
    expect(kinds).toEqual(["secret-variable"]);
  });
});

describe("clipMasked", () => {
  it("does not cut inside a masked span", () => {
    const text = `${"x".repeat(10)}«masked:secret-variable»${"y".repeat(50)}`;
    const clipped = clipMasked(text, 20);
    expect(clipped).toBe(`${"x".repeat(10)} [cut]`);
  });

  it("cuts a plain long text at the limit", () => {
    expect(clipMasked("abcdefghij", 5)).toBe("abcde [cut]");
    expect(clipMasked("abc", 5)).toBe("abc");
  });
});

describe("maskForAudit", () => {
  it("hashes the masked full text, not the raw text", () => {
    const a = maskForAudit("TOKEN_X=aaaaaaaa run", 2000);
    const b = maskForAudit("TOKEN_X=bbbbbbbb run", 2000);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(hashMasked("TOKEN_X=«masked:secret-variable» run"));
    expect(a.length).toBe("TOKEN_X=aaaaaaaa run".length);
  });

  it("hashes the unclipped text so a long call keeps its identity", () => {
    const long = `echo ${"a".repeat(5000)}`;
    const out = maskForAudit(long, 100);
    expect(out.masked.length).toBeLessThan(120);
    expect(out.hash).toBe(hashMasked(long));
  });
});

describe("maskDeep", () => {
  it("masks every string in nested data and leaves other values", () => {
    const out = maskDeep({
      a: "TOKEN_X=zzzzzzzz",
      n: 3,
      list: [
        "PASSWORD=hunter2hunter2",
        { deep: `Authorization: Bearer abcdef` },
      ],
      ok: true,
    });
    expect(JSON.stringify(out)).not.toContain("zzzzzzzz");
    expect(JSON.stringify(out)).not.toContain("hunter2hunter2");
    expect(JSON.stringify(out)).not.toContain("abcdef");
    expect(out.n).toBe(3);
    expect(out.ok).toBe(true);
  });
});

// X9b: the shared rule set runs after the passes above, so a value one of its
// rules knows is masked even where no pass listed the shape.
describe("maskText with the shared rule set", () => {
  const cases = secretCases(11);
  it.each(cases.map((c) => [c.ruleId, c] as const))(
    "masks the %s fixture",
    (_id, c) => {
      const text = c.wrap(c.value);
      const out = maskText(text).text;
      expect(out).not.toContain(c.value);
      expect(maskText(out).text).toBe(out);
    },
  );

  it("masks a provider token the hand-written passes have no shape for", () => {
    const hf = cases.find((c) => c.ruleId === "huggingface-access-token")!;
    const { text, kinds } = maskText(`curl -u me:${hf.value} u`);
    expect(text).not.toContain(hf.value);
    expect(kinds.length).toBeGreaterThan(0);
  });
});

// The false-positive guard: ordinary text the secret scanner's benign corpus
// holds must come through the masker unchanged, except the lines that hold a
// secret-named assignment, header or URL userinfo (the recall-first passes
// mask those placeholders on purpose; this list is the pinned set).
describe("maskText on benign text", () => {
  const SECRET_NAMED =
    /API_KEY|TOKEN|PASSWORD|Authorization|aws_|:\/\/[^\s/:@]+:|BEGIN PRIVATE|AKIA|token=/i;
  const corpus = benignCorpus();

  it("leaves lockfile hashes, ids, commits, data URIs and identifiers alone", () => {
    const plain = corpus.filter((t) => !SECRET_NAMED.test(t));
    expect(plain.length).toBeGreaterThan(30);
    for (const t of plain) expect(maskText(t).text).toBe(t);
  });

  it("changes only the pinned secret-named lines, and never reads a mask as a secret", () => {
    const changed = corpus.filter((t) => maskText(t).text !== t);
    expect(changed.length).toBeLessThanOrEqual(9);
    for (const t of changed) expect(SECRET_NAMED.test(t)).toBe(true);
  });
});
