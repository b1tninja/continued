/**
 * Registry presets for the network allowlist (plans/jail-network.md, W6a):
 * which hosts a package manager needs to work, as data. Nothing here opens
 * anything by itself. A preset is expanded only when a person's settings name
 * it (`preset:npm`), and the settings show the expanded host list.
 *
 * Sources, read 2026-11-10: GitHub's Copilot coding-agent recommended
 * allowlist (docs.github.com, copilot-allowlist-reference), GitHub's runner
 * domain list, and Claude Code's network requirements page. Each preset is to
 * be measured against a real install before it is relied on (row W6d); the
 * caveats below say what was not confirmed.
 */
export interface EgressPreset {
  id: string;
  label: string;
  /** Hosts the ecosystem needs for an ordinary install */
  hosts: readonly string[];
  /** Hosts for less common needs; never expanded by the preset itself */
  optional?: readonly string[];
  /**
   * The preset includes a host that accepts uploads from anyone (a push to any
   * repository, a bucket), so data can leave through it. The settings show a
   * warning next to it.
   */
  exfiltrationRisk?: boolean;
  /** Plain sentences for the settings UI */
  notes: readonly string[];
}

export const EGRESS_PRESETS: readonly EgressPreset[] = [
  {
    id: "npm",
    label: "npm, pnpm, yarn",
    // Tarballs are served from the same host as the metadata
    hosts: ["registry.npmjs.org"],
    optional: [
      // node-gyp headers
      "nodejs.org",
      // classic yarn
      "registry.yarnpkg.com",
      // Prisma engines; Playwright and other tool CDNs are not listed because
      // their hostnames were not confirmed
      "binaries.prisma.sh",
    ],
    notes: [
      "Git dependencies also need the github preset.",
      "Packages that download binaries at install time may need hosts this preset does not list.",
    ],
  },
  {
    id: "pypi",
    label: "pip, uv, poetry",
    hosts: ["pypi.org", "files.pythonhosted.org"],
    optional: ["download.pytorch.org", "pip.pypa.io"],
    notes: [],
  },
  {
    id: "crates",
    label: "cargo",
    // `crates.io` is only the API (search, publish); downloads come from
    // static.crates.io and the sparse index from index.crates.io
    hosts: ["index.crates.io", "static.crates.io", "crates.io"],
    optional: ["static.rust-lang.org", "sh.rustup.rs"],
    notes: [
      "Toolchain downloads (rustup) need the optional hosts.",
      "A git-based registry index needs the github preset.",
    ],
  },
  {
    id: "go",
    label: "Go modules",
    hosts: ["proxy.golang.org", "sum.golang.org"],
    optional: ["go.dev", "dl.google.com"],
    notes: [
      "Copilot's list also names storage.googleapis.com/proxy-golang-org-prod/. A host-only allowlist cannot allow one path of that host, and the whole host accepts uploads to any bucket, so it is deliberately not here.",
      "Unverified: whether module archives are served directly or redirected to that bucket. Measure before relying on this preset; if they are redirected, serve Go through a host-side module cache.",
      "go.dev and dl.google.com are for toolchain downloads only.",
    ],
  },
  {
    id: "maven",
    label: "Maven",
    // The same tree under two names
    hosts: ["repo.maven.apache.org", "repo1.maven.org"],
    notes: [],
  },
  {
    id: "gradle",
    label: "Gradle",
    hosts: [
      "repo.maven.apache.org",
      "repo1.maven.org",
      "services.gradle.org",
      "plugins.gradle.org",
      // The plugin portal redirects here (a forum report; Copilot's list names it)
      "plugins-artifacts.gradle.org",
    ],
    optional: ["maven.google.com", "dl.google.com"],
    notes: [
      "The wrapper downloads the Gradle distribution from services.gradle.org on the first build.",
      "Android projects need the optional hosts.",
    ],
  },
  {
    id: "nuget",
    label: "NuGet, .NET",
    hosts: ["api.nuget.org", "nuget.org"],
    notes: [],
  },
  {
    id: "github",
    label: "GitHub",
    hosts: [
      "github.com",
      "api.github.com",
      "codeload.github.com",
      "raw.githubusercontent.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
      "github-releases.githubusercontent.com",
    ],
    optional: ["github-cloud.githubusercontent.com"],
    exfiltrationRisk: true,
    notes: [
      "github.com accepts a push to any repository and any gist, so allowing it allows data to leave. Stopping pushes needs a proxy that reads the request (a later row).",
      "GitHub documents several of these names as CNAMEs that can change.",
    ],
  },
];

export function findPreset(id: string): EgressPreset | undefined {
  return EGRESS_PRESETS.find((p) => p.id === id);
}
