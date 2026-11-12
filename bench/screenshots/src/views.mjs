// The named views the tool can draw. A view is a fixture of
// harness/fixtures.ts (the state the real app is put into) plus a short note.
// Keep this list in step with FIXTURES there; test/views.test.mjs checks it.
export const VIEWS = {
  chat: {
    fixture: "idle",
    note: "a new, empty chat with the input and its toolbar",
  },
  conversation: {
    fixture: "conversation",
    note: "a finished exchange with markdown and a code block",
  },
  streaming: { fixture: "streaming", note: "a reply that is still arriving" },
  "tool-call": {
    fixture: "tool-call",
    note: "a terminal command card waiting for approval",
  },
  approval: {
    fixture: "approval",
    note: "three calls waiting for approval: a long command, a path outside the workspace, an MCP tool",
  },
  "tool-call-done": {
    fixture: "tool-call-done",
    note: "the same command after it ran",
  },
  held: {
    fixture: "held",
    note: "a reply held back while it is checked for a tool request",
  },
  dialect: {
    fixture: "dialect",
    note: "the notice that a model wrote a tool request as plain text",
  },
  "attach-open": {
    fixture: "attach-open",
    note: 'the "+" menu at the left of the prompt, open',
  },
  "overflow-open": {
    fixture: "overflow-open",
    note: 'the "..." menu under the prompt, open',
  },
  "preset-open": {
    fixture: "preset-open",
    note: "the preset picker above the input, open: a glyph and a tone for each preset",
  },
  loop: {
    fixture: "loop",
    note: "Loop mode: the plan card, per-item budgets and loop controls",
  },
  "loop-plan-tile": {
    fixture: "loop-plan-tile",
    note: "Loop mode: the plan card as a collapsed tile (title, file link, round line, one root row)",
  },
  "loop-plan-running": {
    fixture: "loop-plan-running",
    note: "Loop mode: the plan tree open while running: done fold, current item with live lines, upcoming rows, trace and auto-answer",
  },
  "loop-plan-waiting": {
    fixture: "loop-plan-waiting",
    note: "Loop mode: a re-plan waits to be accepted: dropped struck through, new to-do, kept folded; opens by itself",
  },
  "loop-plan-failed": {
    fixture: "loop-plan-failed",
    note: "Loop mode: an item failed and a repair runs: check output, fix-forward line; opens by itself",
  },
  "loop-plan-finished": {
    fixture: "loop-plan-finished",
    note: "Loop mode: finished, every to-do done folded into one row",
  },
  "settings-models": {
    fixture: "settings-models",
    note: "Settings, Models tab",
  },
  "settings-rules": { fixture: "settings-rules", note: "Settings, Rules tab" },
  "settings-permissions": {
    fixture: "settings-permissions",
    note: "Settings, Permissions tab (render only)",
  },
  "settings-configs": {
    fixture: "settings-configs",
    note: "Settings, Configs tab",
  },
  "settings-indexing": {
    fixture: "settings-indexing",
    note: "Settings, Indexing tab",
  },
  "settings-general": {
    fixture: "settings-general",
    note: "Settings, Settings tab",
  },
  "settings-help": { fixture: "settings-help", note: "Settings, Help tab" },
  "agents-running": {
    fixture: "agents-running",
    note: "the agents tree with long names and unknown costs",
  },
  "agents-ended": {
    fixture: "agents-ended",
    note: "the agents tree after every agent ended, one interrupted",
  },
  "bedrock-ok": {
    fixture: "bedrock-ok",
    note: "Bedrock Test connection, success",
  },
  "bedrock-fail": {
    fixture: "bedrock-fail",
    note: "Bedrock Test connection, failure",
  },
  "permissions-editor": {
    fixture: "permissions-editor",
    note: "Settings, Permissions, with the add-rule form open on a rule that allows every command",
  },
  "permissions-loading": {
    fixture: "permissions-loading",
    note: "Settings, Permissions, while the rules are read, with the slow-read line",
  },
  "permissions-error": {
    fixture: "permissions-error",
    note: "Settings, Permissions, when the read failed: the error and Retry",
  },
  "permissions-intro": {
    fixture: "permissions-intro",
    note: "Settings, Permissions, with the first-run overview card",
  },
  "chat-first-run": {
    fixture: "chat-first-run",
    note: "a new chat for a first-time user, with the one-line first-run notice",
  },
  "audit-list": {
    fixture: "audit-list",
    note: "Settings, Permissions, Recent calls: decisions, who decided, agents, filters",
  },
  "audit-inbox": {
    fixture: "audit-inbox",
    note: "Settings, Permissions, Inbox: open asks oldest first, ages, possibly-ended label, Show older",
  },
  "settings-tools": {
    fixture: "settings-tools",
    note: "Settings, Tools tab, with Commands and secrets",
  },
};

export const VIEW_NAMES = Object.keys(VIEWS);

export const DEFAULTS = {
  widths: [300, 800],
  themes: ["dark", "light"],
  height: 700,
};

/** "a,b" or "a" or "all" to a list of known view names; throws on an unknown one. */
export function parseViews(value) {
  if (!value || value === "all") return [...VIEW_NAMES];
  const names = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!VIEWS[n]) {
      throw new Error(`Unknown view "${n}". Known: ${VIEW_NAMES.join(", ")}`);
    }
  }
  return names;
}

/** "300,800" to [300, 800]; each must be a whole number from 200 to 3000. */
export function parseWidths(value) {
  if (!value) return [...DEFAULTS.widths];
  return value.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 200 || n > 3000) {
      throw new Error(`Bad width "${s}": a whole number from 200 to 3000`);
    }
    return n;
  });
}

/** "dark,light" or "both" to a list of themes. */
export function parseThemes(value) {
  if (!value || value === "both") return [...DEFAULTS.themes];
  return value.split(",").map((s) => {
    const t = s.trim();
    if (t !== "dark" && t !== "light" && t !== "hc") {
      throw new Error(`Bad theme "${s}": dark, light or hc`);
    }
    return t;
  });
}

/** The file name of one picture. */
export function shotName(view, width, theme) {
  return `${view}-${width}-${theme}.png`;
}

/** The full list of pictures for a request, in a stable order. */
export function planJobs({ views, widths, themes, height }) {
  const jobs = [];
  for (const view of views) {
    for (const width of widths) {
      for (const theme of themes) {
        jobs.push({
          view,
          fixture: VIEWS[view].fixture,
          width,
          height,
          theme,
          name: shotName(view, width, theme),
        });
      }
    }
  }
  return jobs;
}
