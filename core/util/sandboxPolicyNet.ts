import { isNetSet } from "../tools/permissions/destinations";
import {
  parseEgressPolicy,
  parseHostRule,
  type HostRule,
} from "./egressPolicy";
import { conflict, put, type Acc, type Ctx } from "./sandboxPolicyAcc";

/** The network half of the compiler: egress policy, model host, host: and net: rules. */

export interface DestRule {
  raw: string;
  program?: string;
  kind: "host" | "net";
  value: string;
}

function hostDomain(rule: HostRule): string {
  const host =
    rule.host.includes(":") && !rule.host.startsWith("[")
      ? `[${rule.host}]`
      : rule.host;
  return `${rule.wildcard ? "*." : ""}${host}${rule.port ? `:${rule.port}` : ""}`;
}

function modelHostRule(raw: string): HostRule | string {
  let host = raw.trim();
  try {
    host = new URL(host).hostname || host;
  } catch {
    // a bare host
  }
  const parsed = parseHostRule(host);
  return "rule" in parsed ? parsed.rule : parsed.error;
}

function hostDenyDomain(
  d: DestRule,
  acc: Acc,
  modeNone: boolean,
): string | undefined {
  const v = d.value.toLowerCase();
  const star = v.indexOf("*");
  const ok =
    star === -1
      ? parseHostRule(v)
      : v.startsWith("*.") && !v.slice(2).includes("*")
        ? parseHostRule(v)
        : undefined;
  if (ok && "rule" in ok) return hostDomain(ok.rule);
  if (!modeNone) {
    conflict(
      acc,
      d.raw,
      "srt's domain list takes a host or *.domain, not this glob; refusing to approximate a deny",
    );
  }
  return undefined;
}

function netDenyRule(
  d: DestRule,
  acc: Acc,
  mode: string,
  viaProxy: boolean,
): void {
  const sets = d.value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (sets.length === 0 || !sets.every(isNetSet)) {
    conflict(acc, d.raw, "names a net set that does not exist; refusing");
    return;
  }
  if (mode === "none") {
    acc.enforced.push({
      effect: "deniedDomains",
      source: "deny-rule",
      from: d.raw,
      entries: [],
      note: "no network at all, so no address can be reached",
    });
  } else if (viaProxy) {
    acc.enforced.push({
      effect: "deniedDomains",
      source: "deny-rule",
      from: d.raw,
      entries: [],
      note: "enforced by our egress proxy, which checks every resolved address (addressChecksByProxy)",
    });
  } else if (sets.includes("private")) {
    conflict(
      acc,
      d.raw,
      "srt's address guard does not cover private ranges; chain our egress proxy (addressChecksByProxy) or use network none",
    );
  } else {
    acc.warnings.push(
      `${d.raw}: relies on srt's resolved-address guard (loopback, link-local, metadata; read in its README, not measured here)`,
    );
  }
}

export function addNetwork(acc: Acc, ctx: Ctx, dest: DestRule[]): void {
  const egress = ctx.input.egress ?? {};
  const parsed = parseEgressPolicy({
    network: egress.network ?? "none",
    allow: egress.allow,
    deny: egress.deny,
  });
  for (const p of parsed.problems) conflict(acc, "egress", p);
  for (const w of parsed.warnings) acc.warnings.push(w);
  const mode = parsed.policy.mode;
  const deniedDomains: string[] = parsed.policy.deny.map(hostDomain);
  if (mode === "none") {
    put(
      acc,
      "allowedDomains",
      [],
      "egress-policy",
      "network: none",
      "no network; the model gateway is a separate component on the host and is not reached through this sandbox",
    );
  } else if (mode === "open") {
    put(
      acc,
      "allowedDomains",
      ["*"],
      "egress-policy",
      "network: open",
      "WEAKENED: srt needs a wildcard to allow everything; every host is reachable through its proxy",
    );
    acc.weakened.push("network-open");
    acc.warnings.push(
      "network is open: srt would need an allowedDomains wildcard, which is weaker than any allowlist; this is not a contained network",
    );
  } else {
    const hosts = parsed.policy.allow.map(hostDomain);
    if (egress.modelHost) {
      const m = modelHostRule(egress.modelHost);
      if (typeof m === "string") conflict(acc, "modelHost", m);
      else
        put(acc, "allowedDomains", [hostDomain(m)], "model-host", "modelHost");
    }
    put(acc, "allowedDomains", hosts, "egress-policy", "egress allow list");
    if (hosts.length === 0 && !egress.modelHost) {
      acc.warnings.push("the allowlist is empty: no network at all");
    }
  }
  for (const d of dest) {
    if (d.kind === "net") {
      netDenyRule(d, acc, mode, egress.addressChecksByProxy === true);
      continue;
    }
    const dom = hostDenyDomain(d, acc, mode === "none");
    if (dom) {
      deniedDomains.push(dom);
      if (d.program) {
        acc.warnings.push(
          `${d.raw}: srt denies the host for every program, which is broader than this rule`,
        );
      }
    }
  }
  if (deniedDomains.length > 0) {
    put(
      acc,
      "deniedDomains",
      deniedDomains,
      "deny-rule",
      "host: rules and egress deny list",
    );
  }
}
