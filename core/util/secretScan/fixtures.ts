/**
 * Fake secrets with the shape of real ones, generated when a test runs.
 *
 * The repository must never hold a secret-looking literal: GitHub push
 * protection and every other scanner would flag it, and a real-looking value
 * in a fixture file is exactly the habit this module exists to stop. So each
 * value is built here from a prefix and seeded random characters. No
 * complete secret appears as a string literal in any file, and the generated
 * characters are random, not derived from any real credential.
 *
 * Test support: imported by `secretScan.vitest.ts` and the CLI test, not by
 * product code.
 */

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ALNUM =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const LOWER_HEX = "0123456789abcdef";
export const B64URL = `${ALNUM}-_`;
export const B64 = `${ALNUM}+/`;
export const UPPER_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

export function randomFrom(
  rng: () => number,
  alphabet: string,
  length: number,
): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(rng() * alphabet.length)];
  }
  return out;
}

export interface SecretCase {
  /** The rule that must find it. */
  ruleId: string;
  /** The fake secret. */
  value: string;
  /** Text around it, as it would appear in a file or a prompt. */
  wrap: (value: string) => string;
  /** The value is in a rule that the outbound profile also runs. */
  outbound: boolean;
}

const bare = (v: string) => `value: ${v} end`;

/** One fake secret per rule, plus the at-rest-only contextual ones. */
export function secretCases(seed = 1): SecretCase[] {
  const r = seeded(seed);
  const rnd = (alphabet: string, n: number) => randomFrom(r, alphabet, n);
  const j = (...parts: string[]) => parts.join("");
  const header = btoa(`{"alg":"HS256","typ":"JWT"}`)
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const payload = btoa(
    `{"sub":"${rnd(DIGITS, 10)}","name":"${rnd(LETTERS, 8)}"}`,
  )
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const pem = j("-----BEGIN ", "RSA PRIVATE ", "KEY-----");
  const pemEnd = j("-----END ", "RSA PRIVATE ", "KEY-----");
  const body = [1, 2, 3].map(() => rnd(B64, 64)).join("\n");
  const mk = (
    ruleId: string,
    value: string,
    outbound = true,
    wrap: SecretCase["wrap"] = bare,
  ): SecretCase => ({ ruleId, value, wrap, outbound });
  return [
    mk(
      "aws-access-key-id",
      j("AKIA", rnd(UPPER_B32, 16)),
      true,
      (v) => `aws_access_key_id = ${v}`,
    ),
    mk(
      "aws-secret-access-key",
      rnd(B64, 40),
      true,
      (v) => `aws_secret_access_key = ${v}`,
    ),
    mk("github-pat", j("gh", "p_", rnd(ALNUM, 36))),
    mk("github-fine-grained-pat", j("github", "_pat_", rnd(ALNUM + "_", 82))),
    mk("github-oauth", j("gh", "o_", rnd(ALNUM, 36))),
    mk("github-app-token", j("gh", "s_", rnd(ALNUM, 36))),
    mk("github-refresh-token", j("gh", "r_", rnd(ALNUM, 36))),
    mk("anthropic-api-key", j("sk", "-ant-api03-", rnd(B64URL, 93), "AA")),
    mk(
      "openai-api-key",
      j("sk", "-proj-", rnd(B64URL, 74), "T3Blb", "kFJ", rnd(B64URL, 74)),
    ),
    mk("openai-project-key", j("sk", "-proj-", rnd(B64URL, 100))),
    mk("openai-legacy-key", j("sk", "-", rnd(ALNUM, 48))),
    mk("openrouter-api-key", j("sk", "-or-v1-", rnd(LOWER_HEX, 64))),
    mk("gcp-api-key", j("AIza", "Sy", rnd(B64URL, 33))),
    mk(
      "slack-bot-token",
      j(
        "xox",
        "b-",
        rnd(DIGITS, 12),
        "-",
        rnd(DIGITS, 12),
        "-",
        rnd(ALNUM, 24),
      ),
    ),
    mk(
      "slack-user-token",
      j(
        "xox",
        "p-",
        rnd(DIGITS, 11),
        "-",
        rnd(DIGITS, 11),
        "-",
        rnd(DIGITS, 12),
        "-",
        rnd(ALNUM, 32),
      ),
    ),
    mk(
      "slack-app-token",
      j(
        "xa",
        "pp-1-",
        rnd("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 11),
        "-",
        rnd(DIGITS, 13),
        "-",
        rnd("abcdef0123456789", 40),
      ),
    ),
    mk(
      "slack-legacy-token",
      j(
        "xox",
        "s-",
        rnd(DIGITS, 11),
        "-",
        rnd(DIGITS, 11),
        "-",
        rnd(DIGITS, 11),
        "-",
        rnd(LOWER_HEX, 32),
      ),
      false,
    ),
    mk(
      "slack-webhook-url",
      j("https://hooks", ".slack.com/services/", rnd(B64, 45)).replace(
        /\+/g,
        "A",
      ),
    ),
    mk("stripe-live-key", j("sk", "_live_", rnd(ALNUM, 24))),
    mk("stripe-test-key", j("sk", "_test_", rnd(ALNUM, 24)), false),
    mk("npm-access-token", j("np", "m_", rnd(ALNUM, 36))),
    mk("pypi-upload-token", j("pypi-", "AgEIcHlwaS5vcmc", rnd(B64URL, 120))),
    mk("huggingface-access-token", j("hf", "_", rnd(LETTERS, 34))),
    mk("gitlab-pat", j("glp", "at-", rnd(B64URL, 20))),
    mk("digitalocean-pat", j("dop", "_v1_", rnd(LOWER_HEX, 64))),
    mk("shopify-access-token", j("shp", "at_", rnd(LOWER_HEX, 32))),
    mk(
      "sendgrid-api-token",
      j("S", "G.", rnd(B64URL, 22), ".", rnd(B64URL, 43)),
    ),
    mk("twilio-api-key", j("S", "K", rnd(LOWER_HEX, 32)), false),
    mk(
      "private-key",
      `${pem}\n${body}\n${pemEnd}`,
      true,
      (v) => `key:\n${v}\nafter`,
    ),
    mk("jwt", j(header, ".", payload, ".", rnd(B64URL, 43)), false),
    mk(
      "connection-string-password",
      rnd(ALNUM, 18),
      false,
      (v) => `DATABASE=postgres://app:${v}@db.internal:5432/main`,
    ),
    mk(
      "bearer-token",
      rnd(ALNUM + "._-", 40),
      false,
      (v) => `Authorization: Bearer ${v}`,
    ),
    mk(
      "env-secret-assignment",
      rnd(ALNUM, 24),
      false,
      (v) => `SERVICE_ACCESS_TOKEN=${v}`,
    ),
    mk(
      "generic-secret",
      rnd(ALNUM, 32),
      false,
      (v) => `const mySecretValue = "${v}";`,
    ),
  ];
}

/** Text that must not be reported: the corpus the false-positive budget is measured on. */
export function benignCorpus(seed = 7): string[] {
  const r = seeded(seed);
  const rnd = (alphabet: string, n: number) => randomFrom(r, alphabet, n);
  const uuid = () =>
    `${rnd(LOWER_HEX, 8)}-${rnd(LOWER_HEX, 4)}-4${rnd(LOWER_HEX, 3)}-a${rnd(LOWER_HEX, 3)}-${rnd(LOWER_HEX, 12)}`;
  const out: string[] = [
    // source code that names secrets without holding them
    `const apiKey = process.env.OPENAI_API_KEY;\nif (!apiKey) throw new Error("missing key");`,
    `api_key = os.environ["ANTHROPIC_API_KEY"]\npassword = getpass.getpass()`,
    `export function getToken(): string { return this.token; }`,
    `const { accessToken, refreshToken } = await client.authenticate(credentials);`,
    `token_count = 4096\nmax_tokens: 8192\n"maxTokens": 100000`,
    `tokenizer = "gpt-4o-mini-2024-07-18"\nsecret_name = "prod-database-credentials"`,
    `password: \${{ secrets.DB_PASSWORD }}\nAPI_KEY=\${OPENAI_API_KEY}\nTOKEN=$GITHUB_TOKEN`,
    `Authorization: Bearer \${token}\nAuthorization: Bearer <your-token-here>`,
    `export OPENAI_API_KEY=your-api-key-here\nANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`,
    `curl -H "Authorization: Bearer $TOKEN" https://api.example.com/v1/items`,
    `postgres://user:password@localhost:5432/db\nmysql://root:\${DB_PASS}@db/app`,
    `.sk-fading-circle { color: red; }\nclass="sk-circle sk-child"`,
    `-----BEGIN PRIVATE KEY----- is the header of a PEM file; the key follows.`,
    `const fixture = "AKIA${rnd(UPPER_B32, 16)}"; // secretscan:allow`,
    `https://github.com/org/repo/commit/${rnd(LOWER_HEX, 40)}`,
    `<img src="data:image/png;base64,${rnd(B64, 400)}">`,
    `"integrity": "sha512-${rnd(B64, 86)}=="`,
    `"resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"`,
    `const veryLongIdentifierNameForAnAbstractFactoryBuilderManagerImpl = createAbstractFactory();`,
    `very_long_snake_case_identifier_for_the_configuration_loader_registry_entry = 1`,
    `session_id: ${uuid()}\nrequest-id=${uuid()}`,
    `sha256:${rnd(LOWER_HEX, 64)}\nmd5 ${rnd(LOWER_HEX, 32)}`,
    `commit ${rnd(LOWER_HEX, 40)}\nAuthor: A Person <a@example.com>`,
    `Use sk-... for the key and ghp_... for the token.`,
    `key=value&token=&page=2`,
  ];
  for (let i = 0; i < 30; i++) {
    out.push(`id=${uuid()} sha=${rnd(LOWER_HEX, 40)} blob=${rnd(B64, 120)}`);
  }
  return out;
}
