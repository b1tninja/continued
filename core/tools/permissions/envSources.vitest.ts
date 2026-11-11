import { describe, expect, it } from "vitest";
import { envAssignmentHit } from "./envAssignments";
import { classifyEnvName } from "./envNames";

/**
 * ROADMAP P16: the names whose class changed when the documents behind
 * `envNames.ts` were re-read on 2026-11-11. Each moved toward stricter; the
 * reason is the line in the sources comment.
 */
describe("names that became stricter after the sources were re-read", () => {
  it.each([
    // python docs: a warning category is a class name, and the warnings module imports it
    ["PYTHONWARNINGS", "dangerous"],
    // AWS CLI: the named config or credentials file can hold credential_process
    ["AWS_CONFIG_FILE", "dangerous"],
    ["AWS_SHARED_CREDENTIALS_FILE", "dangerous"],
    // openssl-env(7)
    ["OPENSSL", "dangerous"],
    ["OPENSSL_CONF_INCLUDE", "dangerous"],
    ["OPENSSL_CONFIG", "dangerous"],
    ["OPENSSL_ENGINES", "dangerous"],
    // cargo: RUSTDOC and RUSTFMT are programs
    ["RUSTDOC", "dangerous"],
    ["RUSTFMT", "dangerous"],
    ["RUSTDOCFLAGS", "dangerous"],
    // about_Environment_Variables
    ["PSModuleAnalysisCachePath", "dangerous"],
  ] as const)("%s is %s", (name, risk) => {
    expect(classifyEnvName(name).risk).toBe(risk);
    expect(classifyEnvName(name.toLowerCase()).risk).toBe(risk);
  });

  it("names the re-read confirmed keep their class", () => {
    expect(classifyEnvName("AWS_PAGER").risk).toBe("dangerous");
    expect(classifyEnvName("PYTHONUNBUFFERED").risk).toBe("harmless");
    expect(classifyEnvName("PYTHONIOENCODING").risk).toBe("harmless");
    expect(classifyEnvName("PYTHONHASHSEED").risk).toBe("harmless");
    expect(classifyEnvName("PYTHONSTARTUP").risk).toBe("dangerous");
    expect(classifyEnvName("BASH_ENV").risk).toBe("dangerous");
    expect(classifyEnvName("CURL_CA_BUNDLE").risk).toBe("sensitive");
    expect(classifyEnvName("AWS_ENDPOINT_URL").risk).toBe("sensitive");
    expect(classifyEnvName("http_proxy").risk).toBe("sensitive");
  });

  it("an assignment of PYTHONWARNINGS or AWS_CONFIG_FILE now asks", () => {
    for (const [c, shell] of [
      ["PYTHONWARNINGS=ignore::pkg.W python a.py", "bash"],
      ["AWS_CONFIG_FILE=/tmp/c aws s3 ls", "bash"],
      ["$env:PYTHONWARNINGS='ignore::pkg.W'; python a.py", "powershell"],
    ] as const) {
      expect(envAssignmentHit(c, shell)?.severity, c).toBe("dangerous");
    }
  });
});
