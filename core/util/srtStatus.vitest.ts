import { describe, expect, it } from "vitest";
import { effectivePolicyPreview } from "./srtPolicyPreview";
import {
  compareVersions,
  detectSrt,
  parseVersion,
  probeSandboxState,
  sandboxStateFromProbe,
  type SrtReaders,
} from "./srtStatus";

const BIN: Record<string, string> = {
  bwrap: "/usr/bin/bwrap",
  socat: "/usr/bin/socat",
  rg: "/usr/bin/rg",
  srt: "/home/u/.srt/node_modules/.bin/srt",
};
const VERSIONS: Record<string, string> = {
  bwrap: "bubblewrap 0.13.1\n",
  socat: "socat by Gerhard Rieger\nsocat version 1.8.0.0 on Jan 1 2025\n",
  rg: "ripgrep 14.1.0\n",
};
const FILES: Record<string, string> = {
  "/proc/version": "Linux version 6.8.0-generic (gcc)",
  "/proc/sys/user/max_user_namespaces": "252480\n",
  "/proc/self/status": "Name:\tnode\nSeccomp:\t0\n",
  "/etc/os-release": "ID=ubuntu\nID_LIKE=debian\n",
};

function readers(over: Partial<SrtReaders> = {}): Partial<SrtReaders> {
  return {
    platform: "linux",
    arch: "x64",
    nodeVersion: "22.22.2",
    which: (n) => BIN[n],
    probeVersion: (file) => VERSIONS[file.split("/").pop() ?? ""],
    readFile: (f) => FILES[f],
    getenv: () => undefined,
    readSrtPackage: () => ({ path: "/x/srt", version: "0.0.82" }),
    ...over,
  };
}

const ids = (s: ReturnType<typeof detectSrt>) => s.missing.map((m) => m.item);

describe("detectSrt on Linux", () => {
  it("is ready when everything is present and no policy blocks namespaces", () => {
    const s = detectSrt(readers());
    expect(s.verdict).toBe("ready");
    expect(s.missing).toEqual([]);
    expect(s.unknown).toEqual([]);
    expect(s.containment).toBe("not-verified");
    expect(s.checks.find((c) => c.id === "bwrap")?.version).toBe("0.13.1");
    expect(s.checks.find((c) => c.id === "socat")?.version).toBe("1.8.0.0");
  });

  it.each([
    ["bwrap", "bwrap", "sudo apt-get install -y bubblewrap"],
    ["socat", "socat", "sudo apt-get install -y socat"],
    ["rg", "ripgrep", "sudo apt-get install -y ripgrep"],
  ])("names a missing %s with a fix", (bin, item, fix) => {
    const s = detectSrt(
      readers({ which: (n) => (n === bin ? undefined : BIN[n]) }),
    );
    expect(s.verdict).toBe("missing");
    expect(ids(s)).toEqual([item]);
    expect(s.missing[0].fix).toBe(fix);
  });

  it("reports a missing srt with the pinned, scripts-off install", () => {
    const s = detectSrt(
      readers({
        readSrtPackage: () => undefined,
        which: (n) => (n === "srt" ? undefined : BIN[n]),
      }),
    );
    expect(s.verdict).toBe("missing");
    expect(s.missing[0].item).toBe("srt");
    expect(s.missing[0].fix).toContain("--ignore-scripts");
    expect(s.missing[0].fix).toContain("--omit=optional");
    expect(s.missing[0].fix).toContain("@0.0.82");
  });

  it("accepts srt found only on PATH, without running it", () => {
    const probed: string[] = [];
    const s = detectSrt(
      readers({
        readSrtPackage: () => undefined,
        probeVersion: (f, a) => {
          probed.push(f);
          return (
            VERSIONS[f.split("/").pop() ?? ""] ?? (a.length ? "" : undefined)
          );
        },
      }),
    );
    expect(s.checks.find((c) => c.id === "srt")?.state).toBe("present");
    expect(probed.some((f) => f.endsWith("/srt"))).toBe(false);
  });

  it("treats a socat that cannot run as broken, not present", () => {
    const s = detectSrt(
      readers({
        probeVersion: (f) =>
          f.endsWith("socat") ? undefined : VERSIONS[f.split("/").pop() ?? ""],
      }),
    );
    expect(s.verdict).toBe("missing");
    expect(s.missing[0]).toMatchObject({ item: "socat", state: "broken" });
    expect(s.missing[0].why).toContain("libssl");
  });

  it("treats bubblewrap older than 0.4.0 as missing and 0.4.x as a warning", () => {
    const old = detectSrt(
      readers({
        probeVersion: (f) =>
          f.endsWith("bwrap")
            ? "bubblewrap 0.3.3"
            : VERSIONS[f.split("/").pop() ?? ""],
      }),
    );
    expect(old.missing[0]).toMatchObject({ item: "bwrap", state: "too-old" });
    const mid = detectSrt(
      readers({
        probeVersion: (f) =>
          f.endsWith("bwrap")
            ? "bubblewrap 0.4.1"
            : VERSIONS[f.split("/").pop() ?? ""],
      }),
    );
    expect(mid.verdict).toBe("ready");
    expect(mid.warnings[0]).toContain("0.5.0");
  });

  it("requires Node 22.12", () => {
    const s = detectSrt(readers({ nodeVersion: "20.11.0" }));
    expect(ids(s)).toEqual(["node"]);
    expect(detectSrt(readers({ nodeVersion: "22.12.0" })).verdict).toBe(
      "ready",
    );
  });

  it("uses the package manager of the distribution for fixes", () => {
    const arch = detectSrt(
      readers({
        which: () => undefined,
        readSrtPackage: () => ({ path: "x" }),
        readFile: (f) => (f === "/etc/os-release" ? "ID=arch\n" : FILES[f]),
      }),
    );
    expect(arch.missing.find((m) => m.item === "bwrap")?.fix).toBe(
      "sudo pacman -S --needed bubblewrap",
    );
  });

  describe("user namespaces", () => {
    const withFiles = (extra: Record<string, string | undefined>) =>
      detectSrt(
        readers({ readFile: (f) => (f in extra ? extra[f] : FILES[f]) }),
      );

    it("is blocked by unprivileged_userns_clone=0", () => {
      const s = withFiles({
        "/proc/sys/kernel/unprivileged_userns_clone": "0\n",
      });
      expect(s.verdict).toBe("missing");
      expect(s.missing[0].item).toBe("user-namespaces");
    });

    it("is blocked by max_user_namespaces=0", () => {
      expect(
        withFiles({ "/proc/sys/user/max_user_namespaces": "0" }).verdict,
      ).toBe("missing");
    });

    it("is unknown (not missing) under the AppArmor restriction", () => {
      const s = withFiles({
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
      });
      expect(s.verdict).toBe("unknown");
      expect(s.unknown[0].item).toBe("user-namespaces");
      expect(s.unknown[0].fix).toContain(
        "apparmor_restrict_unprivileged_userns=0",
      );
    });

    it("stays unknown when no policy file can be read", () => {
      const s = withFiles({ "/proc/sys/user/max_user_namespaces": undefined });
      expect(s.verdict).toBe("unknown");
    });

    it("is present with the Debian knob set to 1", () => {
      expect(
        withFiles({
          "/proc/sys/kernel/unprivileged_userns_clone": "1",
          "/proc/sys/user/max_user_namespaces": undefined,
        }).verdict,
      ).toBe("ready");
    });
  });

  describe("seccomp hints", () => {
    it("is blocked on an architecture without the bundled helper", () => {
      const s = detectSrt(readers({ arch: "riscv64" }));
      expect(s.verdict).toBe("missing");
      expect(s.missing[0].item).toBe("seccomp");
    });

    it("is blocked when the kernel reports no Seccomp line", () => {
      const s = detectSrt(
        readers({
          readFile: (f) =>
            f === "/proc/self/status" ? "Name:\tnode\n" : FILES[f],
        }),
      );
      expect(s.missing[0].item).toBe("seccomp");
    });

    it("is unknown when /proc/self/status cannot be read", () => {
      const s = detectSrt(
        readers({
          readFile: (f) => (f === "/proc/self/status" ? undefined : FILES[f]),
        }),
      );
      expect(s.verdict).toBe("unknown");
    });

    it("accepts arm64", () => {
      expect(detectSrt(readers({ arch: "arm64" })).verdict).toBe("ready");
    });
  });
});

describe("detectSrt on WSL", () => {
  const wsl2 = {
    "/proc/version": "Linux version 6.6.87.2-microsoft-standard-WSL2",
  };
  it("is a supported WSL2 host", () => {
    const s = detectSrt(
      readers({ readFile: (f) => wsl2[f as keyof typeof wsl2] ?? FILES[f] }),
    );
    expect(s.host).toMatchObject({ kind: "wsl2", supported: true });
    expect(s.verdict).toBe("ready");
  });

  it("is unsupported on WSL1, and reads nothing else", () => {
    const boom = () => {
      throw new Error("read");
    };
    const s = detectSrt({
      platform: "linux",
      arch: "x64",
      readFile: (f) =>
        f === "/proc/version" ? "Linux version 4.4.0-19041-Microsoft" : boom(),
      which: boom,
      probeVersion: boom,
      getenv: () => undefined,
    });
    expect(s.host.kind).toBe("wsl1");
    expect(s.verdict).toBe("unsupported");
    expect(s.host.reason).toContain("WSL2");
    expect(s.checks).toEqual([]);
  });

  it("is unknown when WSL is signalled by env but /proc/version is unreadable", () => {
    const s = detectSrt(
      readers({
        readFile: (f) => (f === "/proc/version" ? undefined : FILES[f]),
        getenv: (n) => (n === "WSL_DISTRO_NAME" ? "archlinux" : undefined),
      }),
    );
    expect(s.verdict).toBe("unknown");
    expect(s.unknown[0].item).toBe("wsl-generation");
  });
});

describe("detectSrt on macOS", () => {
  const mac = (over: Partial<SrtReaders> = {}) =>
    detectSrt(
      readers({
        platform: "darwin",
        arch: "arm64",
        which: (n) => ({ ...BIN, "sandbox-exec": "/usr/bin/sandbox-exec" })[n],
        ...over,
      }),
    );

  it("is ready with sandbox-exec and rg, and does not ask for bwrap or socat", () => {
    const s = mac({
      which: (n) =>
        n === "bwrap" || n === "socat"
          ? undefined
          : { ...BIN, "sandbox-exec": "/usr/bin/sandbox-exec" }[n],
    });
    expect(s.host.kind).toBe("macos");
    expect(s.verdict).toBe("ready");
    expect(s.checks.map((c) => c.id)).toEqual([
      "node",
      "srt",
      "sandbox-exec",
      "ripgrep",
    ]);
  });

  it("is missing without sandbox-exec", () => {
    const s = mac({
      which: (n) => (n === "sandbox-exec" ? undefined : BIN[n]),
    });
    expect(s.verdict).toBe("missing");
    expect(ids(s)).toEqual(["sandbox-exec"]);
  });

  it("is missing without rg", () => {
    const s = mac({
      which: (n) =>
        n === "rg"
          ? undefined
          : n === "sandbox-exec"
            ? "/usr/bin/sandbox-exec"
            : BIN[n],
    });
    expect(ids(s)).toEqual(["ripgrep"]);
  });
});

describe("detectSrt on native Windows and others", () => {
  it("is unsupported on Windows with the reason and runs no probes", () => {
    const boom = () => {
      throw new Error("must not read");
    };
    const s = detectSrt({
      platform: "win32",
      arch: "x64",
      readFile: boom,
      which: boom,
      probeVersion: boom,
      readSrtPackage: boom,
      getenv: boom,
    });
    expect(s.verdict).toBe("unsupported");
    expect(s.host).toMatchObject({ kind: "windows", supported: false });
    expect(s.host.reason).toContain("alpha");
    expect(s.host.reason).toContain("WSL2");
    expect(s.host.reason).toContain("Windows Sandbox");
  });

  it("is unsupported on other platforms", () => {
    expect(detectSrt(readers({ platform: "freebsd" })).verdict).toBe(
      "unsupported",
    );
  });
});

describe("fail closed", () => {
  it("never yields ready for an unknown, errored, missing, unsupported or absent probe", () => {
    const unknownProbe = detectSrt(
      readers({
        readFile: (f) => (f.startsWith("/proc/sys") ? undefined : FILES[f]),
      }),
    );
    expect(unknownProbe.verdict).toBe("unknown");
    const missingProbe = detectSrt(readers({ which: () => undefined }));
    const unsupportedProbe = detectSrt(readers({ platform: "win32" }));
    for (const probe of [
      unknownProbe,
      missingProbe,
      unsupportedProbe,
      new Error("boom"),
      undefined,
      null,
    ]) {
      expect(sandboxStateFromProbe(probe).state).toBe("unavailable");
    }
  });

  it("turns a throwing reader into unavailable", () => {
    const state = probeSandboxState(
      readers({
        which: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(state).toEqual({
      state: "unavailable",
      reason: expect.stringContaining("EACCES"),
    });
  });

  it("says probed-ready, never contained, for a clean probe", () => {
    const state = sandboxStateFromProbe(detectSrt(readers()));
    expect(state).toEqual({
      state: "probed-ready",
      containment: "not-verified",
    });
    expect(JSON.stringify(state)).not.toMatch(/"contained"/);
  });
});

describe("version helpers", () => {
  it("parses versions after a marker", () => {
    expect(
      parseVersion("socat by G\nsocat version 1.8.0.0 on x", /socat version/),
    ).toBe("1.8.0.0");
    expect(parseVersion("nothing", /socat version/)).toBeUndefined();
  });
  it("compares versions", () => {
    expect(compareVersions("0.5", "0.5.0")).toBe(0);
    expect(compareVersions("0.4.1", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("22.12.1", "22.12.0")).toBeGreaterThan(0);
  });
});

describe("effectivePolicyPreview", () => {
  const ws = "/home/u/proj";

  it("is labelled a preview and applied nowhere", () => {
    const p = effectivePolicyPreview({ modelHost: "api.example.com" }, ws);
    expect(p).toMatchObject({ preview: true, applied: false, weakened: [] });
    expect(p.label).toContain("PREVIEW");
  });

  it("allows only the model host on the network, strictly", () => {
    const p = effectivePolicyPreview(
      { modelHost: "https://api.example.com/v1" },
      ws,
    );
    expect(p.config.network).toEqual({
      allowedDomains: ["api.example.com"],
      deniedDomains: [],
      strictAllowlist: true,
    });
    const none = effectivePolicyPreview({}, ws);
    expect(none.config.network.allowedDomains).toEqual([]);
    expect(none.notes.join(" ")).toContain("no network");
  });

  it("makes the workspace the only write root and lists the extra denies", () => {
    const p = effectivePolicyPreview({}, ws);
    expect(p.config.filesystem.allowWrite).toEqual([ws]);
    const deny = p.config.filesystem.denyWrite;
    for (const rel of [
      ".envrc",
      ".husky",
      ".continuous",
      ".git/hooks",
      ".git/config",
      ".bashrc",
      ".zshrc",
      ".profile",
    ]) {
      expect(deny).toContain(`${ws}/${rel}`);
    }
    const bySource = Object.fromEntries(
      p.denyWriteSources.map((e) => [
        e.path.slice(ws.length + 1),
        e.inSrtMandatoryList,
      ]),
    );
    expect(bySource[".envrc"]).toBe(false);
    expect(bySource[".husky"]).toBe(false);
    expect(bySource[".continuous"]).toBe(false);
    expect(bySource[".bashrc"]).toBe(true);
  });

  it("denies secrets, and /mnt only on WSL2", () => {
    expect(effectivePolicyPreview({}, ws).config.filesystem.denyRead).toContain(
      "~/.ssh",
    );
    expect(
      effectivePolicyPreview({}, ws).config.filesystem.denyRead,
    ).not.toContain("/mnt");
    expect(
      effectivePolicyPreview({ hostKind: "wsl2" }, ws).config.filesystem
        .denyRead,
    ).toContain("/mnt");
  });

  it("denies the roots and allows the workspace under workspace-only", () => {
    const f = effectivePolicyPreview({ readPolicy: "workspace-only" }, ws)
      .config.filesystem;
    expect(f.denyRead).toEqual(
      expect.arrayContaining(["/home", "/mnt", "/run"]),
    );
    expect(f.allowRead).toEqual([ws]);
  });

  it("calls out what srt does not cover and how later files are handled", () => {
    const p = effectivePolicyPreview({}, ws);
    const items = p.notCovered.map((n) => n.item).join("|");
    expect(items).toContain("/mnt/c");
    expect(items).toContain("environment variables");
    expect(
      p.notCovered.find((n) => n.item.includes("environment"))?.ourMitigation,
    ).toContain("terminalEnvironment");
    expect(p.createdLater).toContain("NOT protected");
  });

  it("warns about a workspace on a Windows drive", () => {
    expect(effectivePolicyPreview({}, "/mnt/d/proj").notes.join(" ")).toContain(
      "Windows drive",
    );
    expect(
      effectivePolicyPreview({}, "D:\\proj").config.filesystem.denyWrite[0],
    ).toBe("D:\\proj\\.envrc");
  });
});
