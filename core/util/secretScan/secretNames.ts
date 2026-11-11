/**
 * Environment variable names that carry a secret or the means to get one:
 * keys, tokens, passwords, cloud and provider prefixes, this product's own
 * variables, and the agent and daemon sockets a shell inherits. `*` matches
 * any run of characters; matching ignores case.
 *
 * Names and values are different checks. This list says which variables to
 * distrust; the rules beside it say which values look like credentials.
 * `scrubEnvironment` and `secretValuesFromEnv` both read this one list.
 * Pure: safe for code the GUI bundles.
 */
export const SECRET_NAME_PATTERNS: readonly string[] = [
  "*API_KEY",
  "*APIKEY",
  "*_KEY",
  "*TOKEN",
  "*SECRET",
  "*SECRET_KEY",
  "*PASSWORD",
  "*PASSWD",
  "*_PASS",
  "*CREDENTIAL",
  "*CREDENTIALS",
  "*PRIVATE_KEY",
  "*ACCESS_KEY",
  "*_PWD",
  "*CONNECTION_STRING",
  "AWS_*",
  "AZURE_*",
  "GCP_*",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_*",
  "CONTINUOUS_*",
  "CONTINUE_*",
  "ANTHROPIC_*",
  "OPENAI_*",
  "BEDROCK_*",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "KUBECONFIG",
  "DATABASE_URL",
  "PGPASSWORD",
  "MYSQL_PWD",
  "NETRC",
];

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
}

const COMPILED = SECRET_NAME_PATTERNS.map(globToRegExp);

/** Whether an environment variable name matches `SECRET_NAME_PATTERNS`. */
export function isSecretName(name: string): boolean {
  return COMPILED.some((r) => r.test(name));
}
