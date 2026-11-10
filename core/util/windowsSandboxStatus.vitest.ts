import { describe, expect, it } from "vitest";
import {
  locateWsb,
  parseVirtualization,
  windowsSandboxStatus,
  windowsSandboxUnavailableMessage,
  type WindowsSandboxReaders,
} from "./windowsSandboxStatus";

const GOOD: WindowsSandboxReaders = {
  findWsb: () => "C:\\Windows\\System32\\wsb.exe",
  readEdition: () => "Professional",
  readBuild: () => 26300,
  readVirtualization: () => true,
};

function status(over: Partial<WindowsSandboxReaders> = {}, platform = "win32") {
  return windowsSandboxStatus({
    platform: platform as NodeJS.Platform,
    readers: { ...GOOD, ...over },
  });
}

describe("windowsSandboxStatus", () => {
  it("is unsupported off Windows and reads nothing", () => {
    const boom = () => {
      throw new Error("read");
    };
    for (const platform of ["linux", "darwin"]) {
      expect(
        status(
          {
            findWsb: boom,
            readEdition: boom,
            readBuild: boom,
            readVirtualization: boom,
          },
          platform,
        ),
      ).toEqual({ state: "unsupported-platform" });
    }
  });

  it("is not installed when wsb.exe is missing", () => {
    expect(status({ findWsb: () => undefined })).toMatchObject({
      state: "not-installed",
      edition: "Professional",
      build: 26300,
    });
  });

  it("is ready on Pro, a new enough build and virtualization", () => {
    expect(status()).toEqual({
      state: "ready",
      wsbPath: "C:\\Windows\\System32\\wsb.exe",
      edition: "Professional",
      build: 26300,
    });
    expect(status({ readEdition: () => "Enterprise" }).state).toBe("ready");
    expect(status({ readBuild: () => 26100 }).state).toBe("ready");
  });

  it("is unusable on Home", () => {
    expect(status({ readEdition: () => "Core" })).toMatchObject({
      state: "installed-but-unusable",
      problems: ["edition"],
    });
  });

  it("is unusable before build 26100", () => {
    expect(status({ readBuild: () => 26099 })).toMatchObject({
      state: "installed-but-unusable",
      problems: ["build"],
    });
  });

  it("is unusable with virtualization off, and lists every problem", () => {
    expect(status({ readVirtualization: () => false })).toMatchObject({
      problems: ["virtualization"],
    });
    expect(
      status({
        readEdition: () => "Core",
        readBuild: () => 22631,
        readVirtualization: () => false,
      }),
    ).toMatchObject({ problems: ["edition", "build", "virtualization"] });
  });

  it("does not block on a reading it could not take", () => {
    expect(
      status({
        readEdition: () => undefined,
        readBuild: () => undefined,
        readVirtualization: () => undefined,
      }).state,
    ).toBe("ready");
  });
});

describe("locateWsb", () => {
  it("prefers PATH, then System32", () => {
    const has = (p: string) =>
      p === "C:\\Users\\a\\WindowsApps\\wsb.exe" ||
      p === "C:\\Windows\\System32\\wsb.exe";
    expect(
      locateWsb("C:\\x;C:\\Users\\a\\WindowsApps", "C:\\Windows", has),
    ).toBe("C:\\Users\\a\\WindowsApps\\wsb.exe");
    expect(locateWsb("C:\\x", "C:\\Windows", has)).toBe(
      "C:\\Windows\\System32\\wsb.exe",
    );
    expect(locateWsb("C:\\x", "C:\\Windows", () => false)).toBeUndefined();
  });
});

describe("parseVirtualization", () => {
  it("is true when the hypervisor or the firmware says so", () => {
    expect(parseVirtualization("True\r\nFalse\r\n")).toBe(true);
    expect(parseVirtualization("False\r\nTrue\r\n")).toBe(true);
  });
  it("is false only when everything says false, undefined with no answer", () => {
    expect(parseVirtualization("False\r\nFalse\r\n")).toBe(false);
    expect(parseVirtualization("")).toBeUndefined();
  });
});

describe("windowsSandboxUnavailableMessage", () => {
  it("is undefined when ready and says how to enable otherwise", () => {
    expect(windowsSandboxUnavailableMessage(status())).toBeUndefined();
    expect(
      windowsSandboxUnavailableMessage(status({ findWsb: () => undefined })),
    ).toContain("Containers-DisposableClientVM");
    expect(
      windowsSandboxUnavailableMessage(status({ readEdition: () => "Core" })),
    ).toContain("Core");
    expect(windowsSandboxUnavailableMessage(status({}, "linux"))).toContain(
      "only available on Windows",
    );
  });
});
