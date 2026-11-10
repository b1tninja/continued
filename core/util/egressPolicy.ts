import {
  hostInNetSet,
  NET_SETS,
  normalizeHost,
} from "../tools/permissions/destinations";
import { findPreset } from "./egressPresets";

/**
 * The network policy of a jail and the decision an egress proxy makes for one
 * connection (plans/jail-network.md, W6a and W6b). Pure: nothing here opens a
 * socket, resolves a name or reads the machine. The proxy that will call
 * `decideEgress` passes its own resolver, and tests pass a stub.
 *
 * Three modes:
 * - `none`: no route anywhere. (The model gateway is a separate component and
 *   is not subject to this policy.)
 * - `allowlist`: named hosts only, through one proxy.
 * - `open`: no proxy and no check; the UI says so plainly.
 *
 * What the allowlist decision guarantees, and what it does not:
 * - Names are resolved here, by the proxy, never in the jail. The caller must
 *   connect to the returned `address` and never resolve the name again, or the
 *   rebinding check below is worth nothing.
 * - Every address of the answer must be public. One loopback, link-local,
 *   private, metadata, multicast, unspecified or the proxy host's own address
 *   refuses the whole answer, so an allowed name that points at the machine
 *   itself fails.
 * - An IP literal (in any spelling `inet_aton` takes) is refused unless the
 *   list names that exact address.
 * - It does not read TLS, so a client that names one host in CONNECT and
 *   another in SNI or Host (domain fronting) is not caught here.
 */
export type EgressMode = "none" | "allowlist" | "open";

export interface HostRule {
  /** Normalised: lower case, no trailing dot, an IP in canonical form */
  host: string;
  /** `*.example.com`: subdomains only, not the apex */
  wildcard: boolean;
  /** Without a port a rule matches the default ports */
  port?: number;
  /** An IP literal; matches only that address */
  literal: boolean;
  /** As written, for messages */
  raw: string;
}

export interface EgressPolicy {
  mode: EgressMode;
  allow: HostRule[];
  /** Checked first and wins over `allow` */
  deny: HostRule[];
}

/** The ports a rule without a port matches: TLS and plain HTTP */
export const DEFAULT_EGRESS_PORTS: readonly number[] = [443, 80];

export const NO_NETWORK: EgressPolicy = { mode: "none", allow: [], deny: [] };

function isIPv4Literal(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function isIPLiteral(host: string): boolean {
  return isIPv4Literal(host) || host.includes(":");
}

/** One entry as written (`registry.npmjs.org`, `*.example.com:8443`, `[::1]:80`). */
export function parseHostRule(
  text: string,
): { rule: HostRule } | { error: string } {
  const raw = text.trim();
  if (!raw) return { error: "empty entry" };
  if (/[\s/@?#]/.test(raw)) {
    return {
      error: `${raw}: a host, optionally with a port, and nothing else`,
    };
  }
  let hostPart = raw;
  let port: number | undefined;
  const v6 = /^(\[[^\]]+\])(?::(\d+))?$/.exec(raw);
  if (v6) {
    hostPart = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else if (raw.split(":").length === 2) {
    const [h, p] = raw.split(":");
    hostPart = h;
    if (!/^\d+$/.test(p)) return { error: `${raw}: the port is not a number` };
    port = Number(p);
  } else if (raw.includes(":")) {
    return { error: `${raw}: an IPv6 address needs brackets` };
  }
  if (port !== undefined && !(port > 0 && port < 65536)) {
    return { error: `${raw}: the port is out of range` };
  }
  const wildcard = hostPart.startsWith("*.");
  if (wildcard) hostPart = hostPart.slice(2);
  const host = normalizeHost(hostPart);
  const literal = isIPLiteral(host);
  if (literal && wildcard) {
    return { error: `${raw}: a wildcard cannot be an address` };
  }
  if (
    !literal &&
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
      host,
    )
  ) {
    return { error: `${raw}: not a host name` };
  }
  if (wildcard && !host.includes(".")) {
    return { error: `${raw}: a wildcard needs a domain, not a top level` };
  }
  return { rule: { host, wildcard, port, literal, raw } };
}

export interface EgressSettings {
  network?: string;
  /** Hosts and `preset:<id>` entries */
  allow?: string[];
  deny?: string[];
}

export interface ParsedEgress {
  policy: EgressPolicy;
  /** Entries that were not understood and were left out */
  problems: string[];
  /** Presets that include a host anyone can upload to */
  warnings: string[];
}

/**
 * The policy for settings. Unknown modes and unreadable entries never loosen
 * anything: an unknown mode is `none`, a bad entry is left out and reported.
 */
export function parseEgressPolicy(settings: EgressSettings = {}): ParsedEgress {
  const problems: string[] = [];
  const warnings: string[] = [];
  let mode: EgressMode = "none";
  if (
    settings.network === "none" ||
    settings.network === "allowlist" ||
    settings.network === "open"
  ) {
    mode = settings.network;
  } else if (settings.network !== undefined) {
    problems.push(
      `network: "${settings.network}" is not none, allowlist or open; using none`,
    );
  }

  const expand = (entries: string[] | undefined, isAllow: boolean) => {
    const rules: HostRule[] = [];
    for (const entry of entries ?? []) {
      const text = entry.trim();
      if (isAllow && text.startsWith("preset:")) {
        const preset = findPreset(text.slice("preset:".length));
        if (!preset) {
          problems.push(`${text}: no such preset`);
          continue;
        }
        if (preset.exfiltrationRisk) {
          warnings.push(
            `${text}: includes a host that accepts uploads from anyone, so data can leave through it`,
          );
        }
        for (const h of preset.hosts) {
          const parsed = parseHostRule(h);
          if ("rule" in parsed) rules.push(parsed.rule);
        }
        continue;
      }
      const parsed = parseHostRule(text);
      if ("rule" in parsed) rules.push(parsed.rule);
      else problems.push(parsed.error);
    }
    return rules;
  };

  return {
    policy: {
      mode,
      allow: expand(settings.allow, true),
      deny: expand(settings.deny, false),
    },
    problems,
    warnings,
  };
}

export function ruleMatches(
  rule: HostRule,
  host: string,
  port: number,
): boolean {
  if (
    rule.port !== undefined
      ? rule.port !== port
      : !DEFAULT_EGRESS_PORTS.includes(port)
  ) {
    return false;
  }
  if (rule.wildcard) return host.endsWith(`.${rule.host}`);
  return host === rule.host;
}

// ---------------------------------------------------------------- addresses

function ipv4Value(dotted: string): number {
  return dotted.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

function inCidr4(dotted: string, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return (
    Math.floor(ipv4Value(dotted) / size) === Math.floor(ipv4Value(base) / size)
  );
}

/**
 * Why an address the proxy would connect to is refused, or undefined when it
 * is fine. Beyond the three named sets (`metadata`, `local`, `private`) this
 * refuses the unspecified and "this network" range, carrier-grade NAT
 * (`100.64.0.0/10`, where overlay networks live), multicast and reserved
 * ranges, IPv6 multicast, and the proxy host's own addresses.
 *
 * Not covered: IPv6 transition forms that embed an IPv4 address other than the
 * IPv4-mapped one `normalizeHost` already unwraps (NAT64 `64:ff9b::/96`, 6to4).
 * A resolver that returns them is an unusual network; add them when a probe
 * shows one.
 */
export function deniedAddressReason(
  address: string,
  ownAddresses: readonly string[] = [],
): string | undefined {
  const a = normalizeHost(address);
  if (!isIPLiteral(a)) return "is not an address";
  if (ownAddresses.some((own) => normalizeHost(own) === a)) {
    return "is this machine's own address";
  }
  for (const set of NET_SETS) {
    if (hostInNetSet(a, set)) return `is in the ${set} range`;
  }
  if (isIPv4Literal(a)) {
    if (a.split(".").some((p) => Number(p) > 255)) return "is not an address";
    if (inCidr4(a, "0.0.0.0", 8)) return "is the unspecified range";
    if (inCidr4(a, "100.64.0.0", 10))
      return "is in the shared (carrier NAT) range";
    if (inCidr4(a, "224.0.0.0", 3)) return "is multicast or reserved";
  } else if (
    /^ff[0-9a-f]{2}:/.test(a) ||
    a === "::" ||
    a === "0:0:0:0:0:0:0:0"
  ) {
    return "is multicast or unspecified";
  }
  return undefined;
}

// ---------------------------------------------------------------- the decision

export interface EgressTarget {
  host: string;
  port: number;
}

export interface EgressDeps {
  /** All addresses of a name. The proxy's own resolver; a stub in tests. */
  resolve(host: string): Promise<string[]>;
  /** Addresses of the machine the proxy runs on */
  ownAddresses?: readonly string[];
}

export type EgressDenyCode =
  | "network-none"
  | "invalid-host"
  | "denied"
  | "not-allowed"
  | "ip-literal"
  | "unresolved"
  | "resolver-error"
  | "address-denied";

export type EgressDecision =
  | {
      allow: true;
      host: string;
      port: number;
      /** Connect to this address. Never resolve the name again. */
      address?: string;
      /** Every address the name resolved to, all of which passed */
      addresses?: string[];
      /** The rule that allowed it, as written */
      rule?: string;
    }
  | {
      allow: false;
      code: EgressDenyCode;
      host: string;
      port: number;
      /** For the agent's tool result and the log: says it was the jail */
      message: string;
    };

const deny = (
  code: EgressDenyCode,
  host: string,
  port: number,
  message: string,
): EgressDecision => ({ allow: false, code, host, port, message });

/**
 * Whether a connection to `target` may go ahead, and to which address. Async
 * only because resolution is.
 */
export async function decideEgress(
  policy: EgressPolicy,
  target: EgressTarget,
  deps: EgressDeps,
): Promise<EgressDecision> {
  const { port } = target;
  const host = normalizeHost(target.host);
  if (policy.mode === "open") return { allow: true, host, port };
  if (policy.mode === "none") {
    return deny(
      "network-none",
      host,
      port,
      `The jail has no network (network: none), so ${host}:${port} was not reached.`,
    );
  }
  if (
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[\x21-\x7e]+$/.test(host)
  ) {
    return deny(
      "invalid-host",
      host,
      port,
      "That is not a host and port the jail's proxy can reach.",
    );
  }

  const denied = policy.deny.find((r) => ruleMatches(r, host, port));
  if (denied) {
    return deny(
      "denied",
      host,
      port,
      `${host}:${port} is denied by the jail's network policy (${denied.raw}).`,
    );
  }

  const literal = isIPLiteral(host);
  const allowed = policy.allow.find(
    (r) => ruleMatches(r, host, port) && r.literal === literal,
  );

  if (literal) {
    // An address is allowed only when the list names that exact address; it is
    // then connected as is, which is also the one way to reach a private
    // address on purpose.
    if (allowed) {
      return {
        allow: true,
        host,
        port,
        address: host,
        addresses: [host],
        rule: allowed.raw,
      };
    }
    return deny(
      "ip-literal",
      host,
      port,
      `${host}:${port} is an address, and the jail's network policy allows hosts by name. Use the host name, or list the address.`,
    );
  }

  if (!allowed) {
    return deny(
      "not-allowed",
      host,
      port,
      `${host}:${port} is not on the jail's network allowlist. Allow it in the sandbox settings (or a preset) if it is needed.`,
    );
  }

  // A name that is itself in a local, private or metadata set
  // (`localhost`, `metadata.google.internal`) is refused before resolving
  for (const set of NET_SETS) {
    if (hostInNetSet(host, set)) {
      return deny(
        "address-denied",
        host,
        port,
        `${host} is a ${set} name; the jail does not reach it.`,
      );
    }
  }

  let addresses: string[];
  try {
    addresses = await deps.resolve(host);
  } catch (e) {
    return deny(
      "resolver-error",
      host,
      port,
      `${host} could not be resolved (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (addresses.length === 0) {
    return deny("unresolved", host, port, `${host} has no address.`);
  }
  const normalised: string[] = [];
  for (const address of addresses) {
    const reason = deniedAddressReason(address, deps.ownAddresses);
    if (reason) {
      return deny(
        "address-denied",
        host,
        port,
        `${host} resolved to ${address}, which ${reason}. The jail does not reach it, even though the name is allowed.`,
      );
    }
    normalised.push(normalizeHost(address));
  }
  return {
    allow: true,
    host,
    port,
    address: normalised[0],
    addresses: normalised,
    rule: allowed.raw,
  };
}
