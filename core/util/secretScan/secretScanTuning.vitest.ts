import { describe, expect, it } from "vitest";

import {
  ALNUM,
  B64,
  benignCorpus,
  falsePositiveShapes,
  LOWER_HEX,
  randomFrom,
  seeded,
} from "./fixtures";
import { redact, scanText } from "./scan";
import {
  characterClasses,
  looksLikePath,
  plausibleAssignedSecret,
  plausibleUrlPassword,
} from "./valueShape";

const SALT = "tuning";
const BS = String.fromCharCode(92);
const DOLLAR = "$";
const AWS_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const r = seeded(11);
const rnd = (alphabet: string, n: number) => randomFrom(r, alphabet, n);
const uuid = () =>
  `${rnd(LOWER_HEX, 8)}-${rnd(LOWER_HEX, 4)}-4${rnd(LOWER_HEX, 3)}-a${rnd(LOWER_HEX, 3)}-${rnd(LOWER_HEX, 12)}`;
const ids = (text: string, profile: "at-rest" | "outbound" = "at-rest") =>
  scanText(text, profile, { salt: SALT }).map((f) => f.ruleId);

describe("env-secret-assignment: false-positive categories (X11a)", () => {
  for (const line of falsePositiveShapes(rnd, uuid)) {
    it(`rejects ${line.replace(/[A-Za-z0-9]{12,}/g, (m) => `<${m.length}>`)}`, () => {
      expect(ids(line)).not.toContain("env-secret-assignment");
      expect(ids(line)).not.toContain("generic-secret");
    });
  }

  it("rejects a backslash-escaped variable reference", () => {
    expect(ids(`PASSWORD=${BS}${DOLLAR}{${rnd("ABCDEFGH", 8)}_PASS}`)).toEqual(
      [],
    );
  });

  it("skips name-based guesses in test, fixture and example paths only", () => {
    const text = `SERVICE_ACCESS_TOKEN=${rnd(ALNUM, 24)}`;
    const at = (path: string) =>
      scanText(text, "at-rest", { salt: SALT, path }).length;
    expect(at("src/config/loader.ts")).toBe(1);
    expect(at("core/auth/token.vitest.ts")).toBe(0);
    expect(at("pkg/tests/data/env.txt")).toBe(0);
    expect(at(`docs${BS}examples${BS}a.env`)).toBe(0);
    expect(at("conf/prod.env")).toBe(1);
  });

  it("does not skip a provider key in a test path", () => {
    const text = `x = AKIA${rnd(AWS_ALPHABET, 16)}`;
    expect(
      scanText(text, "at-rest", { salt: SALT, path: "tests/a.test.ts" }),
    ).toHaveLength(1);
  });
});

describe("env-secret-assignment: recall is kept on true-positive shapes", () => {
  const cases: [string, string][] = [
    ["env file", `SERVICE_ACCESS_TOKEN=${rnd(ALNUM, 24)}`],
    ["json", `{"client_secret": "${rnd(ALNUM, 32)}"}`],
    ["yaml", `api_key: ${rnd(ALNUM, 40)}`],
    ["short password, mixed classes", `DB_PASSWORD=Xk9!mQ2vLp4`],
    ["presigned url parameter", `?x_amz_token=${rnd(ALNUM, 40)}&format=json`],
    ["long api key, weak name", `SOME_API_KEY=${rnd(ALNUM, 32)}`],
    ["bearer", `Authorization: Bearer ${rnd(ALNUM, 40)}`],
  ];
  for (const [name, text] of cases) {
    it(`finds ${name}`, () => {
      expect(scanText(text, "at-rest", { salt: SALT }).length).toBeGreaterThan(
        0,
      );
    });
  }

  it("cuts the value at an ampersand, so the next parameter is not part of it", () => {
    const secret = rnd(ALNUM, 30);
    const text = `?auth_token=${secret}&page=2`;
    const [f] = scanText(text, "at-rest", { salt: SALT });
    expect(text.slice(f.start, f.end)).toBe(secret);
  });
});

describe("value shape tests", () => {
  it("classifies paths", () => {
    expect(looksLikePath("/etc/ssl/private/key.pem")).toBe(true);
    expect(looksLikePath("certs/prod/server")).toBe(true);
    expect(looksLikePath(`${rnd(B64, 12)}/${rnd(ALNUM, 12)}`)).toBe(false);
  });
  it("counts character classes", () => {
    expect(characterClasses("abc")).toBe(1);
    expect(characterClasses("aB3$")).toBe(4);
  });
  it("applies a length and entropy floor by name", () => {
    expect(plausibleAssignedSecret(rnd(ALNUM, 10), "SOME_API_KEY=")).toBe(
      false,
    );
    expect(plausibleAssignedSecret(`aB3${rnd("xyz", 6)}`, "PASSWORD=")).toBe(
      true,
    );
    expect(plausibleAssignedSecret(rnd("ab", 10), "PASSWORD=")).toBe(false);
  });
  it("keeps hex of digest length out when the name is a digest", () => {
    const h = rnd(LOWER_HEX, 40);
    expect(plausibleAssignedSecret(h, "commit_token=")).toBe(false);
    expect(plausibleAssignedSecret(h, "SERVICE_API_KEY=")).toBe(true);
  });
  it("rejects placeholder URL passwords and accepts a generated one", () => {
    for (const p of ["password", "changeme", "XXXXXXXX", "your-password"]) {
      expect(plausibleUrlPassword(p), p).toBe(false);
    }
    expect(plausibleUrlPassword(rnd(ALNUM, 20))).toBe(true);
  });
});

describe("bearer-token and generic-secret path rejects", () => {
  const seg = () => rnd("abcdefgh", 9);
  it("bearer rejects a file path, keeps a token", () => {
    expect(ids(`Bearer ${seg()}/${seg()}/${seg()}.json`)).toEqual([]);
    expect(ids(`Bearer ${rnd(ALNUM, 40)}`)).toContain("bearer-token");
  });
  it("generic-secret rejects slash-separated word segments", () => {
    expect(
      ids(`const mySecretPath = "${seg()}/${seg()}/${seg()}-${seg()}";`),
    ).toEqual([]);
  });
});

describe("url-credential (X11c)", () => {
  const url = (pw: string, scheme = "postgres", host = "db.internal") =>
    `${scheme}://app:${pw}@${host}:5432/main`;

  it("finds a generated password under both profiles and redacts it", () => {
    const pw = rnd(ALNUM, 20);
    const text = `DATABASE_URL=${url(pw)}`;
    for (const profile of ["at-rest", "outbound"] as const) {
      const found = scanText(text, profile, { salt: SALT });
      expect(found.map((f) => f.ruleId)).toEqual(["url-credential"]);
      expect(found[0].action).toBe("redact");
      expect(redact(text, found)).not.toContain(pw);
      expect(redact(text, found)).toContain("app:[REDACTED:url-credential:");
    }
  });

  it("covers the credentialed schemes, including https and redis", () => {
    for (const scheme of ["mongodb+srv", "redis", "amqps", "https", "ftp"]) {
      expect(ids(url(rnd(ALNUM, 16), scheme), "outbound"), scheme).toEqual([
        "url-credential",
      ]);
    }
  });

  it("does not fire on placeholders, variables, short or uniform passwords", () => {
    const bad = [
      "password",
      "changeme",
      `${DOLLAR}{DB_PASSWORD}`,
      `${DOLLAR}DB_PASSWORD_VALUE`,
      "{{ db_password }}",
      "<password>",
      "xxxxxxxxxx",
      "abc123",
      "aaaaaaaaaaaa",
      "your-password-here",
      "%s%s%s%s%s%s",
    ];
    for (const pw of bad) {
      expect(ids(url(pw), "outbound"), pw).toEqual([]);
    }
  });

  it("does not fire on a placeholder host or a URL with no password", () => {
    for (const host of ["host", "example.com", "your-host"]) {
      expect(
        ids(url(rnd(ALNUM, 16), "postgres", host), "outbound"),
        host,
      ).toEqual([]);
    }
    expect(ids("https://user@github.com/org/repo.git", "outbound")).toEqual([]);
    expect(ids("https://api.example.com:8443/v1/items", "outbound")).toEqual(
      [],
    );
  });

  it("wins over connection-string-password on the same span", () => {
    const found = scanText(url(rnd(ALNUM, 20)), "at-rest", { salt: SALT });
    expect(found.map((f) => f.ruleId)).toEqual(["url-credential"]);
  });
});

describe("warn action (X11e)", () => {
  const key = () => `AIza${"S"}y${rnd(`${ALNUM}-_`, 33)}`;

  it("gcp-api-key is warn outbound and redact at-rest", () => {
    const text = `const k = "${key()}";`;
    const out = scanText(text, "outbound", { salt: SALT });
    expect(out.map((f) => [f.ruleId, f.action])).toEqual([
      ["gcp-api-key", "warn"],
    ]);
    expect(scanText(text, "at-rest", { salt: SALT })[0].action).toBe("redact");
  });

  it("redact leaves a warn finding in the text and rewrites a redact one", () => {
    const g = key();
    const aws = `AKIA${rnd(AWS_ALPHABET, 16)}`;
    const text = `g=${g} a=${aws}`;
    const found = scanText(text, "outbound", { salt: SALT });
    expect(found.map((f) => f.action).sort()).toEqual(["redact", "warn"]);
    const out = redact(text, found);
    expect(out).toContain(g);
    expect(out).not.toContain(aws);
  });

  it("every other outbound rule redacts", () => {
    const found = scanText(`k=AKIA${rnd(AWS_ALPHABET, 16)}`, "outbound");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.action === "redact")).toBe(true);
  });
});

describe("PEM handling (X11e)", () => {
  const body = () => [1, 2, 3].map(() => rnd(B64, 64)).join("\n");
  const block = (label: string) =>
    `-----BEGIN ${label}-----\n${body()}\n-----END ${label}-----`;

  it("treats a private key block as high confidence in both profiles", () => {
    const labels = [
      "PRIVATE KEY",
      "RSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "OPENSSH PRIVATE KEY",
    ];
    for (const label of labels) {
      for (const profile of ["at-rest", "outbound"] as const) {
        const f = scanText(block(label), profile, { salt: SALT });
        expect(
          f.map((x) => [x.ruleId, x.confidence, x.action]),
          label,
        ).toEqual([["private-key", "high", "redact"]]);
      }
    }
  });

  it("does not fire on public keys, certificates, requests or the bare header", () => {
    const labels = [
      "PUBLIC KEY",
      "RSA PUBLIC KEY",
      "CERTIFICATE",
      "CERTIFICATE REQUEST",
      "X509 CRL",
      "DH PARAMETERS",
    ];
    for (const label of labels) {
      expect(ids(block(label), "at-rest"), label).toEqual([]);
      expect(ids(block(label), "outbound"), label).toEqual([]);
    }
    expect(
      ids("-----BEGIN PRIVATE KEY----- starts a PEM file", "outbound"),
    ).toEqual([]);
  });
});

describe("benign corpus regression", () => {
  it("reports no false-positive shape at rest", () => {
    for (const l of falsePositiveShapes(rnd, uuid)) {
      expect(scanText(l, "at-rest", { salt: SALT }), l).toEqual([]);
    }
  });
  it("keeps the shared corpus clean outbound", () => {
    for (const t of benignCorpus()) {
      expect(scanText(t, "outbound", { salt: SALT }), t).toEqual([]);
    }
  });
});
