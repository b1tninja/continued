import { describe, expect, it } from "vitest";
import { EGRESS_PRESETS } from "./egressPresets";
import {
  decideEgress,
  deniedAddressReason,
  NO_NETWORK,
  parseEgressPolicy,
  parseHostRule,
  type EgressDeps,
} from "./egressPolicy";

/** A resolver from a table; asks nothing of the network. */
const table =
  (answers: Record<string, string[] | Error>): EgressDeps["resolve"] =>
  async (host) => {
    const a = answers[host];
    if (a instanceof Error) throw a;
    return a ?? [];
  };

const allow = (...allowList: string[]) =>
  parseEgressPolicy({ network: "allowlist", allow: allowList }).policy;

describe("parseHostRule", () => {
  it("reads hosts, wildcards, ports and addresses", () => {
    expect(parseHostRule("Registry.NPMJS.org.")).toMatchObject({
      rule: { host: "registry.npmjs.org", wildcard: false, literal: false },
    });
    expect(parseHostRule("*.example.com:8443")).toMatchObject({
      rule: { host: "example.com", wildcard: true, port: 8443 },
    });
    expect(parseHostRule("[::1]:80")).toMatchObject({
      rule: { host: "::1", literal: true, port: 80 },
    });
    expect(parseHostRule("0x7f.1")).toMatchObject({
      rule: { host: "127.0.0.1", literal: true },
    });
  });

  it("refuses what is not a host", () => {
    for (const bad of [
      "",
      "https://example.com",
      "example.com/path",
      "user@example.com",
      "::1",
      "*.com",
      "*.127.0.0.1",
      "exa mple.com",
      "example.com:abc",
      "example.com:99999",
      "-bad.example.com",
    ]) {
      expect(parseHostRule(bad), bad).toHaveProperty("error");
    }
  });
});

describe("parseEgressPolicy", () => {
  it("defaults to no network, and an unknown mode never loosens", () => {
    expect(parseEgressPolicy().policy).toEqual(NO_NETWORK);
    const parsed = parseEgressPolicy({ network: "yes please" });
    expect(parsed.policy.mode).toBe("none");
    expect(parsed.problems).toHaveLength(1);
  });

  it("expands presets, reports bad entries and warns about upload hosts", () => {
    const parsed = parseEgressPolicy({
      network: "allowlist",
      allow: ["preset:npm", "preset:github", "preset:nope", "bad host"],
    });
    expect(parsed.policy.allow.map((r) => r.host)).toContain(
      "registry.npmjs.org",
    );
    expect(parsed.policy.allow.map((r) => r.host)).toContain("github.com");
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("preset:github");
  });

  it("keeps optional preset hosts out unless named", () => {
    const hosts = parseEgressPolicy({ allow: ["preset:npm"] }).policy.allow.map(
      (r) => r.host,
    );
    expect(hosts).toEqual(["registry.npmjs.org"]);
  });

  it("every preset host is a valid rule and no host is listed twice", () => {
    for (const preset of EGRESS_PRESETS) {
      const all = [...preset.hosts, ...(preset.optional ?? [])];
      expect(new Set(all).size, preset.id).toBe(all.length);
      for (const h of all)
        expect(parseHostRule(h), `${preset.id} ${h}`).toHaveProperty("rule");
    }
    expect(new Set(EGRESS_PRESETS.map((p) => p.id)).size).toBe(
      EGRESS_PRESETS.length,
    );
  });

  it("never lists a host that accepts any bucket or is an address", () => {
    const hosts = EGRESS_PRESETS.flatMap((p) => p.hosts);
    expect(hosts).not.toContain("storage.googleapis.com");
    expect(hosts.every((h) => /[a-z]/.test(h))).toBe(true);
  });
});

describe("decideEgress: modes", () => {
  const never: EgressDeps = {
    resolve: async () => {
      throw new Error("resolved");
    },
  };

  it("none refuses everything without resolving", async () => {
    const d = await decideEgress(
      NO_NETWORK,
      { host: "registry.npmjs.org", port: 443 },
      never,
    );
    expect(d).toMatchObject({ allow: false, code: "network-none" });
  });

  it("open allows everything without resolving", async () => {
    const d = await decideEgress(
      { mode: "open", allow: [], deny: [] },
      { host: "127.0.0.1", port: 22 },
      never,
    );
    expect(d.allow).toBe(true);
  });
});

describe("decideEgress: allowlist", () => {
  const resolve = table({
    "registry.npmjs.org": ["104.16.1.34", "104.16.0.35"],
    "files.pythonhosted.org": ["151.101.0.223"],
    "api.example.com": ["93.184.216.34"],
    "a.b.example.com": ["93.184.216.35"],
    "evil.example.com": ["127.0.0.1"],
    "meta.example.com": ["169.254.169.254"],
    "mixed.example.com": ["93.184.216.34", "10.0.0.5"],
    "v6.example.com": ["2606:4700::1"],
    "v6local.example.com": ["::ffff:7f00:1"],
    "empty.example.com": [],
    "broken.example.com": new Error("SERVFAIL"),
  });
  const deps: EgressDeps = { resolve, ownAddresses: ["93.184.216.99"] };

  it("allows a listed host and returns the pinned address", async () => {
    const policy = allow("preset:npm");
    const d = await decideEgress(
      policy,
      { host: "Registry.NPMJS.org.", port: 443 },
      deps,
    );
    expect(d).toMatchObject({
      allow: true,
      host: "registry.npmjs.org",
      address: "104.16.1.34",
      addresses: ["104.16.1.34", "104.16.0.35"],
      rule: "registry.npmjs.org",
    });
  });

  it("refuses a host that is not listed", async () => {
    const d = await decideEgress(
      allow("preset:npm"),
      { host: "pypi.org", port: 443 },
      deps,
    );
    expect(d).toMatchObject({ allow: false, code: "not-allowed" });
    expect((d as { message: string }).message).toContain("pypi.org");
  });

  it("matches ports: default 443 and 80, or the one that is listed", async () => {
    const policy = allow("api.example.com", "files.pythonhosted.org:8443");
    expect(
      (await decideEgress(policy, { host: "api.example.com", port: 443 }, deps))
        .allow,
    ).toBe(true);
    expect(
      (await decideEgress(policy, { host: "api.example.com", port: 80 }, deps))
        .allow,
    ).toBe(true);
    expect(
      (await decideEgress(policy, { host: "api.example.com", port: 22 }, deps))
        .allow,
    ).toBe(false);
    expect(
      (
        await decideEgress(
          policy,
          { host: "files.pythonhosted.org", port: 443 },
          deps,
        )
      ).allow,
    ).toBe(false);
  });

  it("a wildcard covers subdomains and not the apex; deny wins", async () => {
    const policy = parseEgressPolicy({
      network: "allowlist",
      allow: ["*.example.com"],
      deny: ["evil.example.com", "a.b.example.com"],
    }).policy;
    expect(
      (await decideEgress(policy, { host: "api.example.com", port: 443 }, deps))
        .allow,
    ).toBe(true);
    expect(
      (await decideEgress(policy, { host: "example.com", port: 443 }, deps))
        .allow,
    ).toBe(false);
    expect(
      await decideEgress(policy, { host: "a.b.example.com", port: 443 }, deps),
    ).toMatchObject({
      allow: false,
      code: "denied",
    });
    expect(
      await decideEgress(policy, { host: "notexample.com", port: 443 }, deps),
    ).toMatchObject({
      code: "not-allowed",
    });
  });

  it("refuses an allowed name that resolves to a local, metadata or private address", async () => {
    const policy = allow("*.example.com");
    for (const host of [
      "evil.example.com",
      "meta.example.com",
      "mixed.example.com",
      "v6local.example.com",
    ]) {
      const d = await decideEgress(policy, { host, port: 443 }, deps);
      expect(d, host).toMatchObject({ allow: false, code: "address-denied" });
    }
  });

  it("refuses the proxy host's own address", async () => {
    const own = table({ "own.example.com": ["93.184.216.99"] });
    const d = await decideEgress(
      allow("own.example.com"),
      { host: "own.example.com", port: 443 },
      {
        resolve: own,
        ownAddresses: ["93.184.216.99"],
      },
    );
    expect(d).toMatchObject({ allow: false, code: "address-denied" });
  });

  it("catches rebinding: the answer is checked every time, and the first one is pinned", async () => {
    let calls = 0;
    const rebinding: EgressDeps = {
      resolve: async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]),
    };
    const policy = allow("rebind.example.com");
    const first = await decideEgress(
      policy,
      { host: "rebind.example.com", port: 443 },
      rebinding,
    );
    expect(first).toMatchObject({ allow: true, address: "93.184.216.34" });
    const second = await decideEgress(
      policy,
      { host: "rebind.example.com", port: 443 },
      rebinding,
    );
    expect(second).toMatchObject({ allow: false, code: "address-denied" });
  });

  it("refuses unresolved names and resolver errors", async () => {
    const policy = allow("*.example.com");
    expect(
      await decideEgress(
        policy,
        { host: "empty.example.com", port: 443 },
        deps,
      ),
    ).toMatchObject({
      code: "unresolved",
    });
    const broken = await decideEgress(
      policy,
      { host: "broken.example.com", port: 443 },
      deps,
    );
    expect(broken).toMatchObject({ allow: false, code: "resolver-error" });
    expect((broken as { message: string }).message).toContain("SERVFAIL");
  });

  it("allows a public IPv6 answer", async () => {
    const d = await decideEgress(
      allow("*.example.com"),
      { host: "v6.example.com", port: 443 },
      deps,
    );
    expect(d).toMatchObject({ allow: true, address: "2606:4700::1" });
  });

  it("refuses names that are local by themselves, even when listed, without resolving", async () => {
    const policy = allow(
      "localhost",
      "metadata.google.internal",
      "app.localhost",
    );
    const noResolve: EgressDeps = {
      resolve: async () => {
        throw new Error("resolved");
      },
    };
    for (const host of [
      "localhost",
      "metadata.google.internal",
      "app.localhost",
    ]) {
      expect(
        await decideEgress(policy, { host, port: 80 }, noResolve),
        host,
      ).toMatchObject({
        allow: false,
        code: "address-denied",
      });
    }
  });

  it("refuses IP literals in every spelling unless that exact address is listed", async () => {
    const policy = allow("registry.npmjs.org", "93.184.216.34");
    for (const host of [
      "127.0.0.1",
      "2130706433",
      "0x7f.1",
      "0177.0.0.1",
      "127.1",
      "[::1]",
      "::ffff:127.0.0.1",
      "169.254.169.254",
      "10.1.2.3",
      "8.8.8.8",
    ]) {
      expect(
        await decideEgress(policy, { host, port: 443 }, deps),
        host,
      ).toMatchObject({
        allow: false,
        code: "ip-literal",
      });
    }
    // the listed address, written another way, is the same address
    expect(
      await decideEgress(policy, { host: "0x5db8d822", port: 443 }, deps),
    ).toMatchObject({
      allow: true,
      address: "93.184.216.34",
    });
  });

  it("a listed name does not allow its own address, and a listed address does not allow its name", async () => {
    const policy = allow("api.example.com");
    expect(
      await decideEgress(policy, { host: "93.184.216.34", port: 443 }, deps),
    ).toMatchObject({
      code: "ip-literal",
    });
    const byAddress = allow("93.184.216.34");
    expect(
      await decideEgress(
        byAddress,
        { host: "api.example.com", port: 443 },
        deps,
      ),
    ).toMatchObject({
      code: "not-allowed",
    });
  });

  it("refuses malformed targets", async () => {
    const policy = allow("api.example.com");
    for (const target of [
      { host: "", port: 443 },
      { host: "api.example.com", port: 0 },
      { host: "api.example.com", port: 70000 },
      { host: "api.example.com", port: 1.5 },
      { host: "api.exämple.com", port: 443 },
      { host: "api example.com", port: 443 },
    ]) {
      expect(
        await decideEgress(policy, target, deps),
        JSON.stringify(target),
      ).toMatchObject({
        allow: false,
        code: "invalid-host",
      });
    }
  });
});

describe("deniedAddressReason", () => {
  it("refuses the ranges a jail must not reach", () => {
    for (const a of [
      "127.0.0.1",
      "127.8.8.8",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.100.200",
      "100.64.0.1",
      "0.0.0.0",
      "0.1.2.3",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fd00:ec2::254",
      "ff02::1",
      "::ffff:10.0.0.1",
      "not an address",
    ]) {
      expect(deniedAddressReason(a), a).toBeDefined();
    }
  });

  it("allows public addresses", () => {
    for (const a of [
      "8.8.8.8",
      "93.184.216.34",
      "172.32.0.1",
      "100.63.255.255",
      "2606:4700::1",
    ]) {
      expect(deniedAddressReason(a), a).toBeUndefined();
    }
  });
});
