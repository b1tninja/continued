import { classify } from "./classify.mjs";
import { excerpt, sha256 } from "./excerpt.mjs";
import { VERSION } from "./http.mjs";

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const EXPAND = [
  "config",
  "gated",
  "sha",
  "cardData",
  "pipeline_tag",
  "library_name",
  "lastModified",
];

export function apiUrl(repo) {
  if (!REPO_RE.test(repo)) throw new Error(`bad repo name: ${repo}`);
  return (
    `https://huggingface.co/api/models/${repo}?` +
    EXPAND.map((e) => `expand[]=${e}`).join("&")
  );
}
export function rawUrl(repo, file) {
  if (!REPO_RE.test(repo)) throw new Error(`bad repo name: ${repo}`);
  return `https://huggingface.co/${repo}/raw/main/${file}`;
}

/** Pick the template out of a chat_template value: string, or a list of named templates. */
export function pickTemplate(ct, label) {
  if (typeof ct === "string") return { source: label, text: ct };
  if (Array.isArray(ct)) {
    const d =
      ct.find((x) => x.name === "tool_use") ||
      ct.find((x) => x.name === "default");
    if (d && typeof d.template === "string") {
      return { source: `${label}[${d.name}]`, text: d.template };
    }
  }
  return null;
}

export function templateFromApi(api) {
  const c = api?.config ?? {};
  if (typeof c.chat_template_jinja === "string") {
    return {
      source: "api:config.chat_template_jinja",
      text: c.chat_template_jinja,
    };
  }
  return pickTemplate(
    c.tokenizer_config?.chat_template,
    "api:config.tokenizer_config.chat_template",
  );
}

function summarise(text, source) {
  const c = classify(text);
  return {
    source,
    sha256: text == null ? null : sha256(text),
    length: text == null ? 0 : text.length,
    toolsRendered: c.toolsRendered,
    outcome: c.outcome,
    dialect: c.dialect,
    reason: c.reason,
    markers: c.hits,
    excerpt: text == null ? "" : excerpt(text),
  };
}

/**
 * One repo -> one dataset record. Gated, private and missing repos are
 * recorded as such and nothing more is tried. The template of a gated repo is
 * not read unless `readGated` is set, even though the API happens to return it.
 */
export async function fetchRepo(client, repo, { readGated = false } = {}) {
  const res = await client.get(apiUrl(repo));
  if (res.status !== 200) {
    return {
      repo,
      status: "unavailable",
      detail: `HTTP ${res.status} (gated, private or missing; not distinguished, not worked around)`,
      template: summarise(null, null),
    };
  }
  let api;
  try {
    api = JSON.parse(res.body);
  } catch {
    throw new Error(`unparseable API JSON for ${repo}`);
  }
  const record = {
    repo,
    status: "ok",
    sha: api.sha ?? res.commit ?? null,
    gated: api.gated ?? false,
    license: api.cardData?.license ?? null,
    pipelineTag: api.pipeline_tag ?? null,
    libraryName: api.library_name ?? null,
    lastModified: api.lastModified ?? null,
  };
  if (record.gated) {
    if (!readGated) {
      record.status = "gated";
      record.detail =
        "gated repo: template not read (pass --read-gated-config to use the API copy)";
      record.template = summarise(null, null);
      return record;
    }
  }
  let t = templateFromApi(api);
  if (!t) {
    for (const f of ["chat_template.jinja", "tokenizer_config.json"]) {
      const r = await client.get(rawUrl(repo, f));
      if (r.status !== 200) continue;
      if (f.endsWith(".jinja")) {
        t = { source: `raw:${f}`, text: r.body };
      } else {
        try {
          t = pickTemplate(JSON.parse(r.body).chat_template, `raw:${f}`);
        } catch {
          t = null;
        }
      }
      if (t) break;
    }
  }
  record.template = summarise(t?.text ?? null, t?.source ?? null);
  if (!t) record.detail = "no chat template found in config or raw files";
  return record;
}

export function buildDataset(records, now = new Date()) {
  return {
    tool: `continuous-model-research/${VERSION}`,
    fetchedAt: now.toISOString(),
    note: "Excerpts and sha256 only, never whole templates. Each template is under its repo's licence; see the license field.",
    repos: Object.fromEntries(
      [...records]
        .sort((a, b) => a.repo.localeCompare(b.repo))
        .map((r) => [r.repo, r]),
    ),
  };
}
