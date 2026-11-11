/**
 * Canary secrets for the leak suites (plans/ROADMAP.md X10): fake values with
 * the shape of real credentials, built when a test runs from the same
 * generators as the rule fixtures, so no secret-shaped literal is committed.
 * Each canary is one the shared rule set recognises on its own, with no help
 * from a nearby name: the suites then prove a surface masks by shape.
 *
 * Test support: not imported by product code.
 */
import { secretCases } from "./fixtures";

export interface Canaries {
  anthropicKey: string;
  awsAccessKey: string;
  githubToken: string;
  stripeKey: string;
  npmToken: string;
  /** Every canary, for a loop over the lot. */
  all: string[];
}

export function canarySecrets(seed = 4242): Canaries {
  const cases = secretCases(seed);
  const get = (id: string): string => {
    const found = cases.find((c) => c.ruleId === id);
    if (!found) throw new Error(`no fixture for rule ${id}`);
    return found.value;
  };
  const anthropicKey = get("anthropic-api-key");
  const awsAccessKey = get("aws-access-key-id");
  const githubToken = get("github-pat");
  const stripeKey = get("stripe-live-key");
  const npmToken = get("npm-access-token");
  return {
    anthropicKey,
    awsAccessKey,
    githubToken,
    stripeKey,
    npmToken,
    all: [anthropicKey, awsAccessKey, githubToken, stripeKey, npmToken],
  };
}
