import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectDevcontainer,
  devcontainerStatus,
  DEVCONTAINER_INSTALL_COMMAND,
  parseJsonc,
  whichOnPath,
  type DevcontainerFs,
} from "./devcontainer";

const WS = nodePath.join("/work", "repo");
const p = (...parts: string[]) => nodePath.join(WS, ...parts);

/** An in-memory fs: files keyed by joined path. */
function memFs(files: Record<string, string>): DevcontainerFs {
  const abs: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) abs[p(k)] = v;
  return {
    readFile: (path) => abs[path],
    isFile: (path) => path in abs,
    listDirs: (dir) => {
      const names = new Set<string>();
      for (const f of Object.keys(abs)) {
        const rel = nodePath.relative(dir, f);
        if (!rel.startsWith("..") && rel.includes(nodePath.sep)) {
          names.add(rel.split(nodePath.sep)[0]);
        }
      }
      return [...names].sort();
    },
  };
}

describe("parseJsonc", () => {
  it("accepts comments, trailing commas and a BOM", () => {
    const text = `\uFEFF// top
{
  /* block */ "a": 1, // line
  "b": [1, 2,],
}`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2] });
  });
  it("keeps comment markers and commas inside strings", () => {
    expect(
      parseJsonc(`{"url": "http://x/*y*/", "c": "a,]", "q": "\\" // not"}`),
    ).toEqual({ url: "http://x/*y*/", c: "a,]", q: '" // not' });
  });
  it("returns undefined for text that is not JSON", () => {
    expect(parseJsonc("{ nope")).toBeUndefined();
    expect(parseJsonc("")).toBeUndefined();
  });
});

describe("detectDevcontainer: discovery", () => {
  it("finds nothing in a plain repository", () => {
    expect(detectDevcontainer(WS, memFs({ "README.md": "x" })).configs).toEqual(
      [],
    );
  });

  it("finds each location", () => {
    const d1 = detectDevcontainer(
      WS,
      memFs({ ".devcontainer/devcontainer.json": "{}" }),
    );
    expect(d1.configs.map((c) => c.path)).toEqual([
      p(".devcontainer", "devcontainer.json"),
    ]);
    const d2 = detectDevcontainer(WS, memFs({ ".devcontainer.json": "{}" }));
    expect(d2.configs.map((c) => c.path)).toEqual([p(".devcontainer.json")]);
    const d3 = detectDevcontainer(
      WS,
      memFs({ ".devcontainer/py/devcontainer.json": "{}" }),
    );
    expect(d3.configs[0].folder).toBe("py");
  });

  it("lists them in the spec's order, folders sorted", () => {
    const d = detectDevcontainer(
      WS,
      memFs({
        ".devcontainer/zeta/devcontainer.json": "{}",
        ".devcontainer/alpha/devcontainer.json": "{}",
        ".devcontainer.json": "{}",
        ".devcontainer/devcontainer.json": "{}",
        ".devcontainer/alpha/notes.txt": "x",
        ".devcontainer/empty/Dockerfile": "FROM x",
      }),
    );
    expect(d.configs.map((c) => c.folder ?? nodePath.basename(c.path))).toEqual(
      ["devcontainer.json", ".devcontainer.json", "alpha", "zeta"],
    );
  });

  it("keeps an unparseable file as parsed:false without hiding the others", () => {
    const d = detectDevcontainer(
      WS,
      memFs({
        ".devcontainer/devcontainer.json": "{ broken",
        ".devcontainer.json": `{"image": "x"}`,
      }),
    );
    expect(d.configs[0]).toMatchObject({ parsed: false, risks: [] });
    expect(d.configs[1].summary?.image).toBe("x");
  });

  it("treats a non-object root as unparsed", () => {
    const d = detectDevcontainer(WS, memFs({ ".devcontainer.json": "[1]" }));
    expect(d.configs[0].parsed).toBe(false);
  });

  it("reads the real filesystem by default (nothing there)", () => {
    expect(
      detectDevcontainer(nodePath.join(__dirname, "no-such-dir")).configs,
    ).toEqual([]);
  });
});

describe("detectDevcontainer: summary as found", () => {
  const full = `{
  // an image-based environment
  "name": "dev",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
  },
  "mounts": [
    "source=cache,target=/cache,type=volume",
    { "type": "bind", "source": "/home/me/.aws", "target": "/root/.aws" }
  ],
  "remoteUser": "node",
  "containerUser": "root",
  "runArgs": ["--init", "--memory=2g"],
  "forwardPorts": [3000, "db:5432"],
  "initializeCommand": "echo host",
  "postCreateCommand": ["npm", "ci"],
  "postStartCommand": { "a": "x" },
}`;
  const cfg = () =>
    detectDevcontainer(WS, memFs({ ".devcontainer/devcontainer.json": full }))
      .configs[0];

  it("reports the properties", () => {
    const s = cfg().summary!;
    expect(s.image).toContain("typescript-node");
    expect(s.build).toBeUndefined();
    expect(Object.keys(s.features)).toHaveLength(2);
    expect(s.remoteUser).toBe("node");
    expect(s.containerUser).toBe("root");
    expect(s.runArgs).toEqual(["--init", "--memory=2g"]);
    expect(s.forwardPorts).toEqual([3000, "db:5432"]);
    expect(s.lifecycle).toEqual({
      initializeCommand: "echo host",
      postCreateCommand: ["npm", "ci"],
      postStartCommand: { a: "x" },
    });
  });

  it("parses string and object mounts", () => {
    const m = cfg().summary!.mounts;
    expect(m[0]).toMatchObject({
      type: "volume",
      source: "cache",
      target: "/cache",
    });
    expect(m[1]).toMatchObject({
      type: "bind",
      source: "/home/me/.aws",
      target: "/root/.aws",
    });
  });

  it("flags nothing for a plain config", () => {
    expect(cfg().risks).toEqual([]);
  });

  it("reads build forms", () => {
    const nested = detectDevcontainer(
      WS,
      memFs({
        ".devcontainer.json": `{"build": {"dockerfile": "Dockerfile", "context": ".."}}`,
      }),
    ).configs[0].summary!;
    expect(nested.build).toEqual({ dockerfile: "Dockerfile", context: ".." });
    const legacy = detectDevcontainer(
      WS,
      memFs({ ".devcontainer.json": `{"dockerFile": "D", "context": "."}` }),
    ).configs[0].summary!;
    expect(legacy.build).toEqual({ dockerfile: "D", context: "." });
  });

  it("reads compose settings", () => {
    const s = detectDevcontainer(
      WS,
      memFs({
        ".devcontainer.json": `{"dockerComposeFile": ["a.yml","b.yml"], "service": "app", "workspaceFolder": "/w"}`,
      }),
    ).configs[0].summary!;
    expect(s.dockerComposeFile).toEqual(["a.yml", "b.yml"]);
    expect(s.service).toBe("app");
    expect(s.workspaceFolder).toBe("/w");
    const one = detectDevcontainer(
      WS,
      memFs({ ".devcontainer.json": `{"dockerComposeFile": "a.yml"}` }),
    ).configs[0].summary!;
    expect(one.dockerComposeFile).toEqual(["a.yml"]);
  });

  it("ignores values of the wrong type", () => {
    const s = detectDevcontainer(
      WS,
      memFs({
        ".devcontainer.json": `{"image": 3, "features": [1], "mounts": "x", "runArgs": "--privileged", "forwardPorts": [true, 1]}`,
      }),
    ).configs[0];
    expect(s.summary).toMatchObject({
      features: {},
      mounts: [],
      runArgs: [],
      forwardPorts: [1],
    });
    expect(s.summary!.image).toBeUndefined();
    expect(s.risks).toEqual([]);
  });
});

describe("detectDevcontainer: risks", () => {
  const risks = (json: string) =>
    detectDevcontainer(WS, memFs({ ".devcontainer.json": json })).configs[0]
      .risks;
  const kinds = (json: string) => risks(json).map((r) => r.kind);

  it("flags privileged from the property and from runArgs", () => {
    expect(kinds(`{"privileged": true}`)).toEqual(["privileged"]);
    expect(kinds(`{"runArgs": ["--privileged"]}`)).toEqual(["privileged"]);
    expect(kinds(`{"privileged": false}`)).toEqual([]);
  });

  it("flags the Docker socket in mounts, in both forms, and in runArgs", () => {
    expect(
      kinds(
        `{"mounts": ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"]}`,
      ),
    ).toEqual(["docker-socket"]);
    expect(
      kinds(
        `{"mounts": [{"type":"bind","source":"/var/run/docker.sock","target":"/var/run/docker.sock"}]}`,
      ),
    ).toEqual(["docker-socket"]);
    expect(
      kinds(`{"runArgs": ["-v", "/var/run/docker.sock:/var/run/docker.sock"]}`),
    ).toEqual(["docker-socket"]);
    expect(
      kinds(`{"runArgs": ["--volume=/run/user/1000/docker.sock:/x"]}`),
    ).toEqual(["docker-socket"]);
    expect(
      kinds(
        `{"mounts": ["source=//./pipe/docker_engine,target=/x,type=bind"]}`,
      ),
    ).toEqual(["docker-socket"]);
    expect(
      kinds(
        `{"mounts": ["source=\\\\\\\\.\\\\pipe\\\\docker_engine,target=/x,type=bind"]}`,
      ),
    ).toEqual(["docker-socket"]);
  });

  it("flags host network, pid and ipc", () => {
    expect(kinds(`{"runArgs": ["--network=host"]}`)).toEqual(["host-network"]);
    expect(kinds(`{"runArgs": ["--net", "host"]}`)).toEqual(["host-network"]);
    expect(kinds(`{"runArgs": ["--network=bridge"]}`)).toEqual([]);
    expect(kinds(`{"runArgs": ["--pid=host", "--ipc=host"]}`)).toEqual([
      "host-pid",
      "host-ipc",
    ]);
  });

  it("flags added capabilities from capAdd and runArgs", () => {
    const r = risks(
      `{"capAdd": ["SYS_PTRACE"], "runArgs": ["--cap-add=NET_ADMIN"]}`,
    );
    expect(r.map((x) => x.kind)).toEqual(["capability", "capability"]);
    expect(r[0].message).toContain("SYS_PTRACE");
    expect(r[1].message).toContain("NET_ADMIN");
  });

  it("flags relaxed security options and devices", () => {
    expect(
      kinds(
        `{"securityOpt": ["seccomp=unconfined"], "runArgs": ["--device=/dev/kvm"]}`,
      ),
    ).toEqual(["security-opt", "device"]);
    expect(kinds(`{"securityOpt": ["no-new-privileges"]}`)).toEqual([]);
  });

  it("flags a writable workspace bind mount but not a read-only one", () => {
    expect(
      kinds(
        `{"workspaceMount": "source=\${localWorkspaceFolder},target=/w,type=bind"}`,
      ),
    ).toEqual(["workspace-mount"]);
    expect(
      kinds(
        `{"workspaceMount": "source=\${localWorkspaceFolder},target=/w,type=bind,readonly"}`,
      ),
    ).toEqual([]);
  });

  it("words every risk as a risk, with its source, never as a guarantee", () => {
    const all = risks(
      `{"privileged": true, "capAdd": ["ALL"], "runArgs": ["--network=host"]}`,
    );
    expect(all.length).toBe(3);
    for (const r of all) {
      expect(r.source.length).toBeGreaterThan(0);
      expect(r.message).not.toMatch(/\b(safe|secure|guarantee|contained)\b/i);
    }
  });
});

describe("whichOnPath", () => {
  it("finds a file on a posix PATH", () => {
    const seen = new Set(["/usr/local/bin/devcontainer"]);
    expect(
      whichOnPath("devcontainer", {
        platform: "linux",
        pathEnv: "/usr/bin:/usr/local/bin",
        isFile: (x) => seen.has(x),
      }),
    ).toBe("/usr/local/bin/devcontainer");
  });
  it("tries PATHEXT on Windows", () => {
    const seen = new Set(["C:\\npm\\devcontainer.cmd"]);
    expect(
      whichOnPath("devcontainer", {
        platform: "win32",
        pathEnv: "C:\\bin;C:\\npm",
        pathExt: ".EXE;.CMD",
        isFile: (x) => seen.has(x),
      }),
    ).toBe("C:\\npm\\devcontainer.cmd");
  });
  it("returns undefined when absent or PATH is empty", () => {
    expect(
      whichOnPath("devcontainer", {
        platform: "linux",
        pathEnv: "",
        isFile: () => true,
      }),
    ).toBeUndefined();
    expect(
      whichOnPath("devcontainer", {
        platform: "linux",
        pathEnv: "/a:/b",
        isFile: () => false,
      }),
    ).toBeUndefined();
  });
});

describe("devcontainerStatus", () => {
  it("is unsupported on other platforms", () => {
    expect(
      devcontainerStatus({ platform: "freebsd", which: () => "/x" }),
    ).toEqual({ state: "unsupported-platform" });
  });

  it("is not-installed with the npm install hint", () => {
    const s = devcontainerStatus({ platform: "linux", which: () => undefined });
    expect(s.state).toBe("not-installed");
    if (s.state === "not-installed") {
      expect(s.installHint).toContain(DEVCONTAINER_INSTALL_COMMAND);
      expect(s.installHint).toContain("@devcontainers/cli");
    }
  });

  it("looks the CLI up under the name devcontainer", () => {
    const asked: string[] = [];
    devcontainerStatus({
      platform: "darwin",
      which: (n) => {
        asked.push(n);
        return undefined;
      },
    });
    expect(asked).toEqual(["devcontainer"]);
  });

  it("is installed-but-unusable when the CLI does not answer", () => {
    const s = devcontainerStatus({
      platform: "win32",
      which: () => "C:\\npm\\devcontainer.cmd",
      versionProbe: () => false,
    });
    expect(s.state).toBe("installed-but-unusable");
  });

  it("is installed-but-unusable when the runtime is not usable", () => {
    const s = devcontainerStatus({
      platform: "linux",
      which: () => "/usr/bin/devcontainer",
      versionProbe: () => true,
      runtimeUsable: { usable: false, reason: "docker is not answering" },
    });
    expect(s).toEqual({
      state: "installed-but-unusable",
      reason: "docker is not answering",
    });
  });

  it("is ready with the path, and runs no probe unless given one", () => {
    expect(
      devcontainerStatus({ platform: "linux", which: () => "/usr/bin/dc" }),
    ).toEqual({ state: "ready", cliPath: "/usr/bin/dc" });
    expect(
      devcontainerStatus({
        platform: "linux",
        which: () => "/usr/bin/dc",
        versionProbe: () => true,
        runtimeUsable: { usable: true },
      }).state,
    ).toBe("ready");
  });
});
