/**
 * Provider key rules, as data.
 *
 * Source and licence. Most patterns here are ported from the default rule set
 * of gitleaks (https://github.com/gitleaks/gitleaks, config/gitleaks.toml),
 * Copyright (c) 2019 Zachary Rice, MIT licence. Only the regular expressions
 * and their entropy thresholds are taken, converted from Go's RE2 syntax to
 * JavaScript (`(?i)` groups written out, `\z` and `\x60` replaced, the
 * trailing delimiter written as a lookahead so it is not part of the match).
 * No gitleaks code is used. Each rule's `origin` names the gitleaks rule it
 * comes from, or `own` for one written for this project; a few ported rules
 * are loosened where recall matters more (noted on the rule). The licence
 * text is reproduced in /NOTICE.
 *
 * Every rule has an id, a description and a confidence class. `high` means a
 * fixed prefix and length that almost nothing else has, and is what the
 * outbound profile uses. `medium` and `low` run only in the at-rest profile.
 */
import { decodeBase64Url } from "./heuristics";
import type { SecretRule } from "./types";
import { plausibleUrlPassword } from "./valueShape";

/** The gitleaks tail `(?:[`'"\s;]|\\[nr]|$)`, as a lookahead. */
const END = String.raw`(?=[\x60'"\s;]|\\[nr]|$)`;
/** Not preceded by a character that would make this the middle of a word. */
const START = String.raw`(?<![A-Za-z0-9_])`;

const github = (
  id: string,
  keyword: string,
  body: string,
  description: string,
  origin: string,
): SecretRule => ({
  id,
  kind: "github-token",
  description,
  class: "structural",
  confidence: "high",
  regex: new RegExp(`${START}${body}`, "g"),
  entropy: 3,
  keywords: [keyword],
  origin,
});

const SLACK_KEYWORDS = ["xox", "xapp", "hooks.slack.com"];

export const PROVIDER_RULES: readonly SecretRule[] = [
  {
    id: "aws-access-key-id",
    kind: "aws-access-key",
    description: "AWS access key id (AKIA, ASIA, ABIA, ACCA, A3T prefixes)",
    class: "structural",
    confidence: "high",
    regex: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
    group: 1,
    entropy: 3,
    keywords: ["akia", "asia", "abia", "acca", "a3t"],
    origin: "gitleaks:aws-access-token",
  },
  {
    id: "aws-secret-access-key",
    kind: "aws-secret-key",
    description: "AWS secret access key, 40 characters after its own name",
    class: "structural",
    confidence: "high",
    regex:
      /secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
    entropy: 3.5,
    keywords: ["secret"],
    origin: "own",
  },
  github(
    "github-pat",
    "ghp_",
    "ghp_[0-9a-zA-Z]{36}(?![0-9a-zA-Z])",
    "GitHub personal access token (classic)",
    "gitleaks:github-pat",
  ),
  github(
    "github-fine-grained-pat",
    "github_pat_",
    "github_pat_\\w{82}(?!\\w)",
    "GitHub fine-grained personal access token",
    "gitleaks:github-fine-grained-pat",
  ),
  github(
    "github-oauth",
    "gho_",
    "gho_[0-9a-zA-Z]{36}(?![0-9a-zA-Z])",
    "GitHub OAuth access token",
    "gitleaks:github-oauth",
  ),
  github(
    "github-app-token",
    "gh",
    "(?:ghu|ghs)_[0-9a-zA-Z]{36}(?![0-9a-zA-Z])",
    "GitHub user-to-server or server-to-server token",
    "gitleaks:github-app-token",
  ),
  github(
    "github-refresh-token",
    "ghr_",
    "ghr_[0-9a-zA-Z]{36}(?![0-9a-zA-Z])",
    "GitHub refresh token",
    "gitleaks:github-refresh-token",
  ),
  {
    id: "anthropic-api-key",
    kind: "anthropic-key",
    description: "Anthropic API or admin key (sk-ant-...)",
    class: "structural",
    confidence: "high",
    // gitleaks requires 93 characters and a trailing AA; recall first, so any
    // long sk-ant- token matches.
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}/g,
    entropy: 3,
    keywords: ["sk-ant-"],
    origin: "gitleaks:anthropic-api-key (loosened)",
  },
  {
    id: "openai-api-key",
    kind: "openai-key",
    description: "OpenAI key containing the T3BlbkFJ marker",
    class: "structural",
    confidence: "high",
    regex:
      /\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})/g,
    group: 1,
    entropy: 3,
    keywords: ["t3blbkfj"],
    origin: "gitleaks:openai-api-key",
  },
  {
    id: "openai-project-key",
    kind: "openai-key",
    description: "OpenAI project, service-account or admin key (sk-proj-...)",
    class: "structural",
    confidence: "high",
    regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g,
    entropy: 3.5,
    keywords: ["sk-proj-", "sk-svcacct-", "sk-admin-"],
    origin: "own",
  },
  {
    id: "openai-legacy-key",
    kind: "openai-key",
    description: "OpenAI legacy key, sk- and 48 alphanumeric characters",
    class: "structural",
    confidence: "high",
    regex: /\bsk-[A-Za-z0-9]{48}(?![A-Za-z0-9-])/g,
    entropy: 4,
    keywords: ["sk-"],
    origin: "own",
  },
  {
    id: "openrouter-api-key",
    kind: "openrouter-key",
    description: "OpenRouter key (sk-or-v1- and 64 hex characters)",
    class: "structural",
    confidence: "high",
    regex: /\bsk-or-v1-[a-f0-9]{64}\b/g,
    entropy: 3,
    keywords: ["sk-or-"],
    origin: "own",
  },
  {
    id: "gcp-api-key",
    kind: "google-api-key",
    description: "Google API key (AIza...)",
    class: "structural",
    confidence: "high",
    regex: new RegExp(`\\b(AIza[\\w-]{35})${END}`, "g"),
    group: 1,
    entropy: 3.5,
    keywords: ["aiza"],
    allowlist: { substrings: ["abcdefghijklmnopqrstuvwxyz"] },
    // Browser, Maps and Firebase keys are public by design and 5 of 7 distinct
    // values in the X11 corpus were test data: report, do not rewrite the text.
    outboundAction: "warn",
    origin: "gitleaks:gcp-api-key (entropy 3.5 instead of 4)",
  },
  {
    id: "slack-bot-token",
    kind: "slack-token",
    description: "Slack bot token (xoxb-)",
    class: "structural",
    confidence: "high",
    regex: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
    entropy: 3,
    keywords: SLACK_KEYWORDS,
    origin: "gitleaks:slack-bot-token",
  },
  {
    id: "slack-user-token",
    kind: "slack-token",
    description: "Slack user or config token (xoxp-, xoxe-)",
    class: "structural",
    confidence: "high",
    regex: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/g,
    entropy: 2,
    keywords: SLACK_KEYWORDS,
    origin: "gitleaks:slack-user-token",
  },
  {
    id: "slack-app-token",
    kind: "slack-token",
    description: "Slack app-level token (xapp-)",
    class: "structural",
    confidence: "high",
    regex: /xapp-\d-[A-Za-z0-9]+-\d+-[a-z0-9]+/gi,
    entropy: 2,
    keywords: SLACK_KEYWORDS,
    origin: "gitleaks:slack-app-token",
  },
  {
    id: "slack-legacy-token",
    kind: "slack-token",
    description: "Slack legacy token (xoxo-, xoxs-)",
    class: "structural",
    confidence: "medium",
    regex: /xox[os]-\d+-\d+-\d+-[a-fA-F\d]+/g,
    entropy: 2,
    keywords: SLACK_KEYWORDS,
    origin: "gitleaks:slack-legacy-token",
  },
  {
    id: "slack-webhook-url",
    kind: "slack-webhook",
    description: "Slack incoming webhook URL",
    class: "structural",
    confidence: "high",
    regex:
      /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g,
    keywords: SLACK_KEYWORDS,
    origin: "gitleaks:slack-webhook-url",
  },
  {
    id: "stripe-live-key",
    kind: "stripe-key",
    description: "Stripe live or restricted secret key",
    class: "structural",
    confidence: "high",
    regex: new RegExp(
      `\\b((?:sk|rk)_(?:live|prod)_[a-zA-Z0-9]{10,99})${END}`,
      "g",
    ),
    group: 1,
    entropy: 2,
    keywords: ["sk_live_", "rk_live_", "sk_prod_", "rk_prod_"],
    origin: "gitleaks:stripe-access-token",
  },
  {
    id: "stripe-test-key",
    kind: "stripe-key",
    description: "Stripe test-mode secret key",
    class: "structural",
    confidence: "medium",
    regex: new RegExp(`\\b((?:sk|rk)_test_[a-zA-Z0-9]{10,99})${END}`, "g"),
    group: 1,
    entropy: 2,
    keywords: ["sk_test_", "rk_test_"],
    // The key in Stripe's own documentation.
    allowlist: { substrings: ["4eC39HqLyjWDarjtT1zdp7dc"] },
    origin: "gitleaks:stripe-access-token",
  },
  {
    id: "npm-access-token",
    kind: "npm-token",
    description: "npm access token (npm_ and 36 characters)",
    class: "structural",
    confidence: "high",
    regex: new RegExp(`\\b(npm_[A-Za-z0-9]{36})${END}`, "g"),
    group: 1,
    entropy: 3,
    keywords: ["npm_"],
    origin: "gitleaks:npm-access-token",
  },
  {
    id: "pypi-upload-token",
    kind: "pypi-token",
    description: "PyPI upload token",
    class: "structural",
    confidence: "high",
    regex: /pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}/g,
    entropy: 3,
    keywords: ["pypi-ageichlwas5vcmc"],
    origin: "gitleaks:pypi-upload-token",
  },
  {
    id: "huggingface-access-token",
    kind: "huggingface-token",
    description: "Hugging Face access token (hf_ and 34 letters)",
    class: "structural",
    confidence: "high",
    regex: new RegExp(`\\b(hf_[A-Za-z]{34})${END}`, "g"),
    group: 1,
    entropy: 3,
    keywords: ["hf_"],
    origin: "gitleaks:huggingface-access-token",
  },
  {
    id: "gitlab-pat",
    kind: "gitlab-token",
    description: "GitLab personal access token",
    class: "structural",
    confidence: "high",
    regex: /glpat-[\w-]{20}(?![\w-])/g,
    entropy: 3,
    keywords: ["glpat-"],
    origin: "gitleaks:gitlab-pat",
  },
  {
    id: "digitalocean-pat",
    kind: "digitalocean-token",
    description: "DigitalOcean personal access token",
    class: "structural",
    confidence: "high",
    regex: new RegExp(`\\b(dop_v1_[a-f0-9]{64})${END}`, "g"),
    group: 1,
    entropy: 3,
    keywords: ["dop_v1_"],
    origin: "gitleaks:digitalocean-pat",
  },
  {
    id: "shopify-access-token",
    kind: "shopify-token",
    description: "Shopify admin access token",
    class: "structural",
    confidence: "high",
    regex: /shpat_[a-fA-F0-9]{32}/g,
    entropy: 2,
    keywords: ["shpat_"],
    origin: "gitleaks:shopify-access-token",
  },
  {
    id: "sendgrid-api-token",
    kind: "sendgrid-key",
    description: "SendGrid API key",
    class: "structural",
    confidence: "high",
    regex: new RegExp(`\\b(SG\\.[A-Za-z0-9=_\\-.]{66})${END}`, "g"),
    group: 1,
    entropy: 2,
    keywords: ["sg."],
    origin: "gitleaks:sendgrid-api-token",
  },
  {
    id: "twilio-api-key",
    kind: "twilio-key",
    description: "Twilio API key (SK and 32 hex characters)",
    class: "structural",
    confidence: "medium",
    regex: /\bSK[0-9a-fA-F]{32}\b/g,
    entropy: 3,
    keywords: ["sk"],
    origin: "gitleaks:twilio-api-key",
  },
  {
    id: "url-credential",
    kind: "url-credential",
    description:
      "Password in a URL of a known credentialed scheme (scheme://user:password@host)",
    class: "structural",
    confidence: "high",
    // The password is the capture. A host that is a placeholder (host, server,
    // example, your...) is excluded here; the password's own shape (length,
    // not a placeholder word or a variable, mixed characters) in `validate`.
    regex:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|https?|ftps?|sftp|ssh|smtps?|ldaps?|mssql|sqlserver|clickhouse|cockroachdb|git\+https?):\/\/[^\s:/@'"<>]{1,64}:([^\s@/'"<>]{8,128})@(?!(?:host(?:name)?|server|example|domain|(?:your|my)[\w-]*)(?:[.:/\s'"]|$))[A-Za-z0-9[]/g,
    group: 1,
    keywords: ["://"],
    validate: (value) => plausibleUrlPassword(value),
    origin: "own (masker URL_USERINFO), X11c shape checks",
  },
  {
    id: "private-key",
    kind: "private-key",
    description: "PEM private key block (a truncated block is reported too)",
    class: "structural",
    confidence: "high",
    // gitleaks: -----BEGIN ...PRIVATE KEY-----[\s\S-]{64,}?KEY-----. Here the
    // body must be base64 or header lines, and may run to the end of the text
    // when the block was cut off.
    regex:
      /-----BEGIN[ A-Z0-9_-]{0,40}PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=:,\s-]{64,}?(?:-----END[ A-Z0-9_-]{0,40}PRIVATE KEY(?: BLOCK)?-----|(?![A-Za-z0-9+/=:,\s-]))/g,
    keywords: ["-----begin"],
    origin: "gitleaks:private-key (body restricted)",
  },
  {
    id: "jwt",
    kind: "jwt",
    description: "JSON Web Token whose header decodes to JSON",
    class: "structural",
    confidence: "medium",
    regex: new RegExp(
      `\\b(ey[A-Za-z0-9]{17,}\\.ey[A-Za-z0-9/\\\\_-]{17,}\\.(?:[A-Za-z0-9/\\\\_-]{10,}={0,2})?)${END}`,
      "g",
    ),
    group: 1,
    entropy: 3,
    keywords: ["ey"],
    validate: (value) =>
      /^\{.*"(?:alg|typ)"/.test(decodeBase64Url(value.split(".")[0])),
    origin: "gitleaks:jwt (header must decode)",
  },
];
