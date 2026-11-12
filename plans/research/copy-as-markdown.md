# Copy as Markdown: copying what the chat shows

Research report, 2026-11-12. Evidence is read from `origin/main` (a shallow clone for this report) and from sources cited by URL. Nothing here is built and `plans/ROADMAP.md` is not edited: section 11 holds the exact rows for an integrator. It complements [`input-drag-drop-paste-context.md`](input-drag-drop-paste-context.md) (paste, `Ctrl+Alt+V`, decisions D1 to D9) and the Track UX deep dive in PR #705 (`research/area-ux-surfaces.md`, not yet on main; it proposes UX33 to UX37).

Convention: "verified" means read in code on `origin/main` for this report. "Predicted" means inferred from source and not run on a host. "Unverified" marks an external claim the fetch did not confirm or that comes from memory; it must be re-checked before it is relied on.

## 1. Summary and recommendation

1. **The raw Markdown source exists and is already what the message copy button copies.** `ResponseActions.tsx` passes `renderChatMessage(item.message)` (the model's text, images stripped) to `CopyIconButton`. So option (a) is nearly built; its defects are not the source but the surface around it (section 2.2).
2. **The copy affordances are weak, not absent.** The message Copy button has `tabIndex={-1}` (not reachable by keyboard), the code-block `CopyButton` is a `div` with an `onClick` (no role, no focus, no keyboard), `useCopy` ignores the promise from `navigator.clipboard.writeText` (a rejected write still shows "Copied"), the success state is a tick with no `announce()`, and nothing copies a table, a tool result, a plan, a diff, a turn or a conversation as Markdown. There is no export or share path.
3. **The rendered view is not a pure function of the source.** Links with a scheme other than `http`, `https` or `mailto` are dropped by `safeMarkdownHref`; a custom `remarkTables` re-parses pipe tables; `patchNestedMarkdown` rewrites nested fences; mermaid, math and highlighted code are swapped for components. Serialising the DOM (option b) therefore copies something different from what the model wrote, and in places loses information. The source is the truth; the DOM is a view.
4. **Recommended design: source-first, block-aware.** Copy the original Markdown by default (a), add per-block copies that come from the AST node's original text (e), and write `text/plain` = Markdown plus an optional rendered `text/html` produced from the same source with the existing sanitiser (d). Do not serialise the DOM except for the selection case (c), and there only as a later slice with a golden corpus.
5. **MVP (UX38 to UX40, all S or M):** a repaired copy path (await the write, catch, announce, keyboard-reachable), per-message "Copy as Markdown", code-block and table copy, and a golden corpus of real answers that pins the output. Everything else waits.
6. **Privacy rules are cheap and binding.** Copy only what the person can see or what the message source holds; never expand a masked value; strip the hidden Unicode the input already strips (D8) from what is written; never send anything to a third party by default (no gist).

## 2. Current state (verified on origin/main)

### 2.1 Where the text lives

| Thing                | Where                                                                                                 | Note                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model's text         | `ChatHistoryItem.message.content` (string or parts) in the Redux session                              | `stripImages` joins text parts with `\n`; `renderChatMessage` returns `message.content` verbatim for a `tool` role                                                        |
| Reasoning            | `item.reasoning.text`, shown by `ThinkingBlockPeek`                                                   | Separate from `message.content`; `renderChatMessage` of an assistant message never contains it                                                                            |
| Tool calls           | `item.toolCallStates` and tool-role messages                                                          | Rendered by `pages/gui/ToolCallDiv/*` (RunTerminalCommand, EditFile, PlanCard, SubagentCard, FindAndReplace, McpAppTurn)                                                  |
| Rendered answer      | `StyledMarkdownPreview` (`react-remark`, `remarkMath`, `rehypeKatex`, custom plugins)                 | `source` prop is the original string                                                                                                                                      |
| Raw view             | `uiConfig.displayRawMarkdown` in `StepContainer.tsx`                                                  | A setting already shows the source in a `<pre>`; proof that the source is the accepted fallback                                                                           |
| Code block raw text  | `data-codeblockcontent` set in a remark plugin from `node.value`                                      | The block's content before highlighting; `CopyButton` gets `codeBlockContent`, not the highlighted DOM, so line wrapping, highlighting and any injected chrome never leak |
| Code block file path | `data-relativefilepath` parsed from the fence meta                                                    | Not part of the copy; copying a block loses `path` from ` ```ts path/to/file.ts `                                                                                         |
| Clipboard write      | `hooks/useCopy.tsx`: JetBrains posts `copyText` to the IDE, elsewhere `navigator.clipboard.writeText` | No `await`, no `catch`, no format other than `text/plain`                                                                                                                 |

### 2.2 Affordances today

| Surface                    | What exists                                                                                                                                | Gap                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Message (assistant, tool)  | `CopyIconButton` in `ResponseActions`, tooltip "Copy" then "Copied", `tabIndex={-1}`                                                       | Not keyboard reachable; no announcement; copies `message.content` only (no reasoning, no tool calls)                              |
| Code block                 | `CopyButton`, tooltip "Copy Code", a `div` with `onClick`                                                                                  | No role, no `tabIndex`, no accessible name beyond the tooltip; no language or path; no failure state                              |
| Terminal / command output  | `UnifiedTerminal` uses the same `CopyButton` with `copyContent` = command + output                                                         | Copies command and output together with no way to copy one; truncation is not marked                                              |
| Plan card, loop plan       | `PlanCard.tsx` has no copy (grep)                                                                                                          | A plan cannot be copied as a checklist                                                                                            |
| Diff views                 | Apply, reject and insert actions only                                                                                                      | No "copy as unified diff"                                                                                                         |
| Table                      | None                                                                                                                                       | A table copied by selection loses its pipes (plain text is tab separated in Chromium, predicted)                                  |
| Conversation               | None. History page lists and deletes sessions                                                                                              | No export, no copy turn, no share                                                                                                 |
| Selection and context menu | `OSRContextMenu.tsx` offers Copy, Cut and Paste for the JCEF off-screen mode only; the VS Code webview menu is the browser's               | No "Copy as Markdown" entry anywhere. `extensions/vscode/package.json` has no `webview/context` contribution (also true for UX28) |
| CLI TUI                    | Ink app (`extensions/cli/src/ui`); no copy action in `TUIChat.tsx` or `UserInput.tsx` (grep for `copy` finds only image-in-clipboard code) | Terminal selection is the only path; no OSC 52; no way to copy the last answer                                                    |
| `cn -p`                    | `-p/--print`, `--format json`, `--silent` (strips think tags) in `extensions/cli/src/index.ts`                                             | Plain print is already Markdown text (the model's source); no front matter or transcript mode                                     |
| JetBrains                  | `copyText` message to Kotlin: `Toolkit.getDefaultToolkit().systemClipboard`, `StringSelection`                                             | Text only; no HTML flavor; works because `navigator.clipboard` is not relied on there                                             |

### 2.3 Differences between the rendered view and the source

| Transformation                                       | In view, not in source (or reverse)                                                                                                                                     | Copy consequence                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Syntax highlighting (`rehypeHighlightPlugin`)        | Spans in the DOM; text is the same                                                                                                                                      | None if code is taken from the node value                                                                 |
| Code toolbar chrome (Apply, Insert, Copy, file name) | In the DOM only                                                                                                                                                         | A DOM-serialiser would copy "Apply Insert Copy" text unless it skips the chrome                           |
| `safeMarkdownHref`                                   | `vscode://`, `file:`, `command:` links are removed from the view but present in the source                                                                              | Source copy keeps the dangerous link; decide (section 3): keep as written, it is the model's text         |
| File and symbol links (`FilenameLink`, `SymbolLink`) | Inline code that matches a context item becomes a clickable link                                                                                                        | Source has plain `` `file.ts` ``; DOM would give a link with an internal target                           |
| `remarkTables`                                       | Regex re-parse of paragraphs that look like a table                                                                                                                     | A table the model wrote with a slightly off separator row renders as a table but is not one in the source |
| `patchNestedMarkdown`                                | Rewrites nested fences so the preview does not break                                                                                                                    | Source is the un-patched text; copy source and the pasted result can differ from what you saw             |
| Math (KaTeX), mermaid                                | Replaced by rendered nodes; KaTeX adds a MathML copy plus HTML copy                                                                                                     | A DOM serialiser would copy both renderings; source copy keeps `$...$` and the mermaid fence              |
| Images (`SecureImageComponent`, `imageSourceRisk`)   | Risky remote images are blocked in the view                                                                                                                             | Source keeps the URL; a rich HTML copy must not re-introduce a blocked image                              |
| Reasoning                                            | Separate peek block                                                                                                                                                     | Off by default in any copy (section 4.6)                                                                  |
| Streaming                                            | The last message grows token by token; the last code block is `data-islastcodeblock`                                                                                    | Copy while streaming copies the text received so far (section 5.9)                                        |
| Masked secrets                                       | Not found as a GUI display feature on main (grep for redaction in `gui/src` finds only unrelated hits); `core/llm/logFormatter.ts` and the cache tooling redact in logs | If a masking layer lands (X-track), copy must read through it; the rule is in section 7                   |

### 2.4 Host clipboard constraints (predicted unless noted)

- **VS Code webview.** `navigator.clipboard.writeText` works from a user gesture (the existing code relies on it). `navigator.clipboard.write([new ClipboardItem(...)])` is a Chromium API and should work in the Electron webview under the same gesture rule; Phase 0 must measure it, with `text/html` and with `text/markdown`, because the webview iframe's permissions policy is host-controlled. Fallback: a host message `copyText` implemented with `vscode.env.clipboard.writeText` (text only; the extension already uses it in `terminalShellSetting.ts`).
- **JetBrains JCEF.** The existing path avoids the web clipboard entirely and posts `copyText`; only a string is written. A rich copy needs a Kotlin change that adds an HTML flavor (`DataFlavor.allHtmlFlavor` or a custom `Transferable`); that is a later slice (S2) and may be refused.
- **`text/markdown` on the clipboard.** MDN's `ClipboardItem` page documents string or `Blob` values keyed by MIME type and `ClipboardItem.supports()`; it does not list `text/markdown` as supported (fetched 2026-11-12, <https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem>). Treat it as unsupported until `supports("text/markdown")` says otherwise at run time, and never rely on it: the Markdown goes in `text/plain`.
- **Sanitisation on write.** Browsers sanitise `text/html` on clipboard write in some engines (unverified: the Async Clipboard specification, <https://w3c.github.io/clipboard-apis/>, should be read for the exact rule). Do not depend on `<style>` or script surviving; use inline styles that the target app maps, or none.

## 3. Correctness details that make or break it

| #   | Case                               | Rule                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Code fence length                  | When a block's content contains a run of N backticks, wrap it in a fence of at least N+1 backticks (min 3). Use `~~~` when the info string contains a backtick. Inline code: choose a delimiter longer than any run inside and pad with a space if the code starts or ends with a backtick (CommonMark rule, <https://spec.commonmark.org/0.31.2/>, unverified section numbers)                                                   |
| 2   | Language tag                       | Keep the original info string (`ts path/to/file.ts`); never invent one. Block copy: raw content with no fence by default; "Copy as fenced block" adds the fence with the original info string                                                                                                                                                                                                                                     |
| 3   | GFM tables                         | Escape `\|` in cells as `\|`; replace a newline in a cell with `<br>`; keep alignment colons; trim trailing spaces; a table with a ragged row is padded to the header width; pad or not for alignment is cosmetic, do not pad (keeps diffs small)                                                                                                                                                                                 |
| 4   | Table as CSV / TSV                 | Cell text from the mdast `text` and `inlineCode` values (not the DOM); RFC 4180-style quoting for CSV (look up with rfclib before implementing); TSV replaces tab and newline in a cell with a space                                                                                                                                                                                                                              |
| 5   | Nested lists                       | Copy from source, so indentation is the model's. For a DOM or mdast serialiser use `mdast-util-to-markdown` with `bullet: "-"`, `listItemIndent: "one"`, `rule: "-"`, `emphasis: "*"`, `strong: "*"` so output is stable                                                                                                                                                                                                          |
| 6   | Task lists, blockquotes, footnotes | Task `- [ ]` and `- [x]` keep their marks; footnote definitions are copied with their references (a per-block copy of a paragraph with `[^1]` drops the definition: warn or append it)                                                                                                                                                                                                                                            |
| 7   | HTML in Markdown                   | The view sanitises it; the source keeps it. Copy the source; the rich HTML variant passes through the same sanitiser as paste (UX28)                                                                                                                                                                                                                                                                                              |
| 8   | Math, mermaid                      | Source keeps `$..$`, `$$..$$` and the fence. Do not copy KaTeX output. Offer "Copy mermaid source" for a mermaid block                                                                                                                                                                                                                                                                                                            |
| 9   | Links                              | Copy as written. File links: the view turns `` `file.ts` `` into a link only when it matches a context item; the copy keeps the backticks. Relative paths stay relative; do not rewrite to `vscode://` (a link that works only on this machine). Dropped schemes (`vscode:`, `file:`) are copied as written in the source copy and flagged "contains links this view does not open" only if the owner wants it (open question Q6) |
| 10  | Images                             | `![alt](url)` kept; data URIs and blocked images are replaced by `![alt](url-omitted)` in conversation exports (size, privacy)                                                                                                                                                                                                                                                                                                    |
| 11  | Line endings                       | `\n` in the model's string. Windows: write `\r\n` only to a file export if the owner asks (Q7); the clipboard gets `\n` (Chromium converts as the target needs, unverified)                                                                                                                                                                                                                                                       |
| 12  | Trailing whitespace                | Trim trailing spaces on each line except a hard break (two spaces or backslash before a newline); end with one `\n`                                                                                                                                                                                                                                                                                                               |
| 13  | Unicode                            | Do not normalise (NFC would change a code sample); remove the hidden characters D8 lists (tags block, bidi controls, zero-width space) from what is copied, keep joiners and emoji selectors, and report the count in the announcement                                                                                                                                                                                            |
| 14  | Very large output                  | Cap a single copy at 1 MiB with a notice "Copied the first 1 MiB; N more not copied" and a "Save as file" action for the rest; the cap is a constant, not a setting, in v1                                                                                                                                                                                                                                                        |
| 15  | Streaming                          | Copy during streaming copies the complete blocks received (up to the last blank line outside a fence); the label says "Copy so far"; the last open code block is excluded unless closed. Chunks are never re-rendered to produce the copy                                                                                                                                                                                         |
| 16  | Tool output truncation             | The view's truncation marker is not text in the source. A copy of a truncated output ends with `[output truncated: kept N of M lines]` so a paste elsewhere cannot be mistaken for the full output                                                                                                                                                                                                                                |
| 17  | Think blocks                       | Excluded by default; "Include reasoning" is a per-copy checkbox in the conversation export only                                                                                                                                                                                                                                                                                                                                   |
| 18  | Citations, file chips              | Citations are source text and are copied as written; context chips on a user message copy as `@path` lines in a header block, not as content                                                                                                                                                                                                                                                                                      |

### 3.1 Test plan

**Golden corpus** (`gui/src/components/StyledMarkdownPreview/__fixtures__/copy/*.md` plus expected outputs): 40 real answers, collected from the session logs the owner already keeps (redacted by hand), chosen to include: a nested list with a fenced block inside, a code block containing triple backticks, a table with `\|` and an empty cell, a task list, a blockquote with a code block, a footnote, inline HTML (`<details>`), a math block, a mermaid block, a CRLF answer, a streaming cut mid-fence, a 2 MB tool output, a tool output with ANSI escapes, an answer with a `vscode://` link, a message with a masked-looking token, a message with a zero-width space and a tag-block character. Each case has `.md` input and expected `.copy.md`, `.copy.html` (after the sanitiser), `.copy.txt`.

**Round-trip property tests** (`fast-check`): for generated mdast trees, `toMarkdown(tree)` then `fromMarkdown` equals the tree modulo position and normalisation (the property: parse(serialise(parse(x))) equals parse(x) for any x from a grammar of GFM constructs). A second property: copying a block then pasting it with UX28 (Paste as Markdown) is idempotent.

**Component tests**: Testing Library, `userEvent.keyboard` on the toolbar: Tab reaches Copy, Enter copies, the announcer receives exactly one message, focus stays on the button. A fake `navigator.clipboard` rejects once to prove the failure message.

**Accessibility and screenshots**: add views `copy-menu-open`, `copy-toast-failure` and `copy-conversation-dialog` to `bench/screenshots` at 300 px and 800 px, dark and light, high contrast and reduced motion, scanned by `axe-core` (UX36); the baseline must not gain an entry.

## 4. Design options and trade-offs

| Option                                | What                                                                       | For                                                                   | Against                                                                                                                                                                   | Verdict                          |
| ------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| (a) Original source, verbatim         | `renderChatMessage(item.message)` as today                                 | Exact, cheap, no new dependency, no DOM; already built                | Includes links the view hides; not what the eye saw for tables the view repaired; no formatting in Word                                                                   | MVP                              |
| (b) Serialise rendered DOM (turndown) | HTML to Markdown                                                           | What you see is what you copy                                         | Loses code language, escapes aggressively (turndown's regex escaping is documented as aggressive), copies chrome and KaTeX twice, needs skip rules                        | Not for whole messages           |
| (c) Selection as Markdown             | Map the DOM selection to mdast positions, then slice the source            | Copies exactly the part selected, from the source                     | Needs position data on every rendered node (rehype `data-` attributes), partial-block edge cases, a11y of the menu                                                        | Slice 3                          |
| (d) Multi-format write                | `text/plain` = Markdown, `text/html` = sanitised render of the same source | Pastes formatted into Gmail, Slack, Word and as Markdown into editors | Target apps differ in which flavor they prefer: Markdown-aware editors choose `text/plain`, rich ones `text/html`; webview support to be measured; JetBrains needs Kotlin | Slice 2                          |
| (e) Per-block copy                    | Code, table (Markdown, CSV, TSV), diff (unified patch), command, file path | Highest value per click; no ambiguity                                 | More buttons in a 300 px layout                                                                                                                                           | MVP for code and table           |
| (f) Copy turn, plan, conversation     | Header option, redaction, collapse long outputs                            | Issues and PRs need the whole thread                                  | Privacy surface: tool outputs hold file contents                                                                                                                          | Slice 4                          |
| (g) Export to file, share as gist     | Save `.md`; gist uploads to a third party                                  | File export is local and safe                                         | A gist leaves the machine; never a default, never a one-click                                                                                                             | File: slice 4. Gist: not planned |

### 4.1 Recommended behaviour

- `Copy` (existing, now repaired) keeps meaning "text of this message". The new default for an assistant message is the same Markdown. Nothing changes silently: the tooltip becomes "Copy as Markdown".
- `Copy as Markdown` and `Copy as plain text` are two items of one menu on the message actions; plain text strips the syntax (mdast to text, links as `text (url)`).
- Code block: `Copy code` (raw content, existing behaviour with a real button). A second item "Copy as fenced block" in the block's menu.
- Table: a small toolbar on hover and on focus-within: `Copy table` (Markdown), "Copy as CSV", "Copy as TSV".
- Diff: `Copy diff` (unified patch, from the edit's old and new text, with `a/` and `b/` paths relative to the workspace).
- Command (terminal block): `Copy command`, `Copy output`, `Copy both` (today's behaviour is "both" only).
- Plan card and loop plan: `Copy plan as checklist` (`- [x]` and `- [ ]`, with the round and status as plain words).

### 4.2 Menus (ASCII, 300 px safe)

Message actions, existing icon row plus one overflow-free menu button (Headless UI `Menu`, as the `+` attach menu in `AttachMenu.tsx`):

```
 [Compact] [Restore] [Delete] [Copy v] [Feedback]
                              +--------------------+
                              | Copy as Markdown   |
                              | Copy as plain text |
                              | Copy as rich text  |   (slice 2)
                              |--------------------|
                              | Copy turn...       |   (slice 4)
                              | Save as .md file...|   (slice 4)
                              +--------------------+
```

Table toolbar (visible on hover and on keyboard focus within the table; never covers cells at 300 px: it sits above the table, wraps, and shows icons with names only in the tooltip when under 300 px):

```
 [Copy table v]
 +----------------+
 | Markdown       |
 | CSV            |
 | TSV            |
 +----------------+
 | Fruit | Colour |
 | ...            |
```

Selection (slice 3): right-click or `Shift+F10` on a selection in the answer shows the host menu plus "Copy selection as Markdown" (VS Code `webview/context` contribution keyed on a `data-vscode-context` attribute; JetBrains: the OSR menu). Keyboard path without the context menu: command `continue.copySelectionAsMarkdown`.

### 4.3 Labels, shortcuts and accessibility

| Item                     | Visible label                | Accessible name                   | Shortcut proposal                                    |
| ------------------------ | ---------------------------- | --------------------------------- | ---------------------------------------------------- |
| Message copy menu button | icon + "Copy"                | "Copy this message, menu"         | none (menu opened with Enter or Space)               |
| Copy as Markdown         | "Copy as Markdown"           | "Copy this message as Markdown"   | `Ctrl+Alt+C` / `Cmd+Alt+C` when a message is focused |
| Copy as plain text       | "Copy as plain text"         | "Copy this message as plain text" | none                                                 |
| Code `Copy code`         | icon, tooltip "Copy code"    | "Copy code, <language>"           | none; Enter on the focused button                    |
| Table menu               | "Copy table"                 | "Copy this table, menu"           | none                                                 |
| Selection                | "Copy selection as Markdown" | same                              | `Ctrl+Alt+Shift+C` (slice 3, palette command too)    |

- **Collisions** (checked in `extensions/vscode/package.json` `contributes.keybindings`, verified): the extension binds `ctrl+l`, `ctrl+shift+l`, `shift+ctrl+enter`, `shift+ctrl+backspace`, `ctrl+z`, `up`, `down`, `alt+ctrl+y`, `alt+ctrl+n`, `ctrl+i`, `escape`, `ctrl+shift+r`, `ctrl+k ctrl+m`, `ctrl+k ctrl+a`, `ctrl+alt+space`, `alt+a`, `ctrl+k ctrl+n`, `tab`. None is `ctrl+alt+c`. VS Code's default `ctrl+shift+c` opens an external terminal and `ctrl+alt+c` is unbound in the default keymap (unverified: re-check <https://code.visualstudio.com/docs/reference/default-keybindings>). Plain `Ctrl+C` is never rebound: it stays the host's copy of the selection. `Ctrl+Alt` is AltGr on some Windows layouts; the keyboard matrix must include German and Polish (the same caveat as `Ctrl+Alt+V` in D2).
- **Keyboard-only path**: each message's action row becomes part of the message's tab sequence (drop `tabIndex={-1}` on the Copy button, or make the row a roving-tabindex toolbar with one stop and arrow keys; Q4). The table toolbar is reachable by Tab when the table or a cell has focus.
- **Announcements**: success `announce("Copied as Markdown")`, failure `announce("Could not copy. The clipboard is blocked.")`, large `announce("Copied the first 1 MiB as Markdown")`. Use the existing `announce()` from `components/a11y/announcer.ts`. **No new `aria-live` region.** The visual tick stays, with `aria-hidden`.
- **Focus**: after a copy, focus stays on the control that was activated; a menu closes and returns focus to its button. A dialog (slice 4) traps focus and returns it to the opener.
- **Narrow 300 px**: one menu button, not four icons; labels in the menu, not on the toolbar; targets at least 24 px.
- **High contrast and reduced motion**: the tick is an icon with text "Copied" in the tooltip (not colour alone), uses `forced-colors` safe tokens, and the 2 s flash has no animation under `vscode-reduce-motion` (the existing `reducedMotion.ts` classes).

## 5. Per-surface detail

### 5.1 Code block

Content from `data-codeblockcontent`. Add the info string and path so "Copy as fenced block" restores them. The `CopyButton` becomes a `button` with the same classes; the HoverItem wrapper remains.

### 5.2 Tool output

Copy comes from the tool message's text, not the DOM, and ends with the truncation marker of row 16. ANSI escapes are stripped (the terminal view already interprets them; a paste into an issue must not carry `ESC[`).

### 5.3 Plans

`PlanCard.tsx` has the plan state in Redux; the checklist comes from the state, one line per item, with round and status in words ("done", "dropped", "replaced by").

### 5.4 Diffs

From the edit's before and after text, produce a unified diff (the `diff` package is likely already a dependency; confirm before adding one). Paths are workspace-relative.

### 5.5 Conversation

Header options (all off by default except the title): title, date, model, mode; cost and token counts off. Each turn is `## User`, `## Assistant`, `### Tool: <name>` with the tool's arguments in a fenced `json` block and the result collapsed to 200 lines with the truncation marker; the reasoning is omitted. The "redact tool outputs" toggle replaces every tool result with `[tool output omitted]`.

### 5.6 CLI and TUI

- `cn -p` already prints the Markdown source; add nothing.
- A TUI slash command `/copy` copies the last assistant message (and `/copy 2` the one before) through OSC 52 first and a platform helper second (`clip.exe`, `pbcopy`, `wl-copy`, `xclip`; the CLI already starts `powershell`, `osascript` and `xclip` in the clipboard monitor that UX31 replaces). OSC 52 is `ESC ] 52 ; c ; <base64> BEL` per the xterm control sequence document (unverified: the page was fetched on 2026-11-12 but its OSC 52 entry was beyond the part the fetch read, <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>); terminals commonly disable the write or the read by default, and `tmux` needs `set-clipboard on` (unverified). Print "Copied N characters" and fall back to writing a temp file path when no method works.
- `/export` writes a `.md` of the session to a path the person names.

### 5.7 JetBrains

Text only in the MVP through the existing `copyText`. Rich HTML and selection are slice 5, gated by a Phase 0 measure of JCEF behaviour, the same gate as D9.

## 6. External research

All fetched or searched on 2026-11-12 unless marked; the competitor rows are **unverified** (from product knowledge, not fetched for this report) and must be re-checked before the owner relies on them.

| Product / source              | What it does                                                                                                                                                                                                                                            | Status                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Claude.ai                     | A Copy button under a reply copies the reply as Markdown (not rendered text); code blocks have their own Copy. <https://claude.ai>                                                                                                                      | Unverified                   |
| ChatGPT                       | Copy under a reply puts Markdown on the clipboard; known complaints include tables and LaTeX arriving as raw syntax and "copy" differing from selecting. <https://chatgpt.com>                                                                          | Unverified                   |
| GitHub Copilot Chat (VS Code) | Per-code-block Copy and Insert; "Copy" on a response and a command to export a chat as JSON (`Chat: Export Chat...`). <https://code.visualstudio.com/docs/copilot/chat/copilot-chat>                                                                    | Unverified; re-read the page |
| Cursor                        | Copy on a code block; chat export to Markdown has been a long-standing request. <https://cursor.com>                                                                                                                                                    | Unverified                   |
| Cline                         | Copy on a code block; task history can be exported as Markdown (feature "Export Task History"). <https://docs.cline.bot>                                                                                                                                | Unverified                   |
| Zed                           | Agent panel messages have a Copy action; thread can be copied as Markdown (`agent: copy thread` command, unverified name). <https://zed.dev/docs/ai/agent-panel>                                                                                        | Unverified                   |
| Gemini                        | Copy on a reply copies formatted text; "Export to Docs" and "Share". <https://gemini.google.com>                                                                                                                                                        | Unverified                   |
| `text/markdown` media type    | RFC 7763 registers `text/markdown` (informational, 2016-03; read through the rfclib MCP on 2026-11-12). RFC 7764 §3 registers syntax variants including GitHub Flavored Markdown (§3.2) and CommonMark (§3.5)                                           | Verified via rfclib          |
| `ClipboardItem`               | String or `Blob` values keyed by MIME type; `supports()` exists; MDN does not list `text/markdown` (<https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem>, 2026-11-12)                                                                       | Verified for what it omits   |
| turndown                      | MIT; options `codeBlockStyle` (`indented` default), `fence`, `bulletListMarker` (`*` default); GFM from the separate `turndown-plugin-gfm`; escaping is regex based and can be aggressive (<https://github.com/mixmark-io/turndown>, 2026-11-12)        | Verified                     |
| remark / unified              | `mdast-util-to-markdown` serialises an mdast tree with explicit style options, the right tool for table, task list and fence output from the AST (<https://github.com/syntax-tree/mdast-util-to-markdown>; `mdast-util-gfm` adds tables and task lists) | Unverified (not fetched)     |
| OSC 52                        | See 5.6                                                                                                                                                                                                                                                 | Unverified                   |

What this implies: every peer has per-block copy and a message copy; the differentiators are table copy in three formats, plan and diff copy, redaction on conversation export, and the keyboard path. Because the repository already runs `react-remark` (unified), `mdast-util-to-markdown` adds no new tool family; `turndown` is added only if UX28 already brings it in.

## 7. Privacy and security

1. **Masked values**: every copy reads the same store the view reads (the redacted text if a masking layer exists). Never reconstruct a value from an unmasked log. Test: a fixture message containing a masked token copies masked.
2. **Hidden characters**: strip per D8 on write; count them in the announcement.
3. **Tool outputs** hold file contents. In a conversation export the default is "omit tool outputs longer than 200 lines" and a visible checkbox "Include tool outputs".
4. **Clipboard history**: a copy lands in OS clipboard history (Windows `Win+V`, macOS managers); the docs say so in one line next to the setting for conversation export. No automatic clearing in v1 (Q8).
5. **No network**: "Share as gist" is not planned; a file export is local. If the owner wants a share action, it is a separate row with its own consent text and a block on `.env`-like content.
6. **Rich HTML** is produced from the sanitised render (the same allow-list as UX28) and never includes a blocked remote image.

## 8. Phased plan

| Phase | Rows       | Content                                                                                                                                                                        | Size  |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 0     | UX38       | Measure on real hosts: `ClipboardItem` with `text/html`, `text/markdown` and the `supports()` answer in the VS Code webview, JCEF and a browser; `Ctrl+Alt+C` reaches the page | S     |
| 1     | UX39, UX40 | Repaired copy path; Copy as Markdown on a message; code and table copy; golden corpus                                                                                          | S + M |
| 2     | UX41       | Rich text (`text/html` plus `text/plain`) through the sanitised render; `copyText` HTML flavor for JetBrains                                                                   | M     |
| 3     | UX42       | Selection as Markdown with source positions; menu entry and command                                                                                                            | L     |
| 4     | UX43       | Copy turn, plan and diff; conversation export to `.md` with header and redaction options                                                                                       | M     |
| 5     | UX44       | CLI `/copy` and `/export`, OSC 52                                                                                                                                              | S     |

Dependencies: UX36 (axe in CI) makes the accessibility checks mechanical; UX28 (Paste as Markdown) shares the sanitiser and the `turndown` decision; UX22 shares the hidden-character function; UX18 (built) supplies the announcer. None blocks the MVP.

## 9. Acceptance checklist (MVP)

- [ ] The message Copy button is reachable by keyboard and has an accessible name; the code Copy is a `button`.
- [ ] A rejected `navigator.clipboard` write shows a failure and announces it; a success announces once.
- [ ] "Copy as Markdown" output equals the golden file for all 40 corpus cases, on Windows and Linux runners (CRLF case included).
- [ ] A code block that contains ``` is copied with a longer fence; a table cell with `|` or a newline survives a round trip.
- [ ] No new `aria-live`; no new dependency except (if chosen) `mdast-util-to-markdown`.
- [ ] Views at 300 px in dark, light, high contrast and reduced motion; `axe-core` clean for the new views.
- [ ] Copying a message with a zero-width space or a tag-block character removes it and says so.
- [ ] JetBrains: plain Markdown reaches the system clipboard through `copyText` (manual check, recorded).

## 10. Open questions for the owner

| #   | Question                                                                           | Recommended, pending owner                                                                    |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Q1  | Should the plain Copy button copy Markdown or plain text?                          | Markdown (as today), menu offers plain text                                                   |
| Q2  | Include reasoning in any copy?                                                     | No by default; a per-export checkbox in the conversation export only                          |
| Q3  | Shortcut for "Copy as Markdown"                                                    | `Ctrl+Alt+C` / `Cmd+Alt+C` with a focused message; test AltGr layouts; palette command always |
| Q4  | Make the action row a roving-tabindex toolbar or give each button a Tab stop?      | Roving toolbar (one stop per message, arrows move), to keep long threads tabbable             |
| Q5  | Rich text (`text/html`) in v1?                                                     | No; slice 2 after the Phase 0 measure                                                         |
| Q6  | Copy links the view refuses to open (`vscode:`, `file:`)?                          | Copy as written (it is the model's text); no flag                                             |
| Q7  | CRLF on Windows for file export?                                                   | `\n` everywhere; CRLF only if asked in a setting                                              |
| Q8  | Clear the clipboard after N seconds for tool-output copies?                        | No (surprising); document the clipboard-history caveat                                        |
| Q9  | "Share as gist"?                                                                   | Not planned; local file export only                                                           |
| Q10 | Conversation header fields on by default?                                          | Title and date only; model, mode, cost and tokens off                                         |
| Q11 | Corpus source: may real (redacted) answers from the owner's sessions be committed? | Yes, after redaction by hand, in `__fixtures__`; synthetic cases cover the rest               |

## 11. Proposed ROADMAP rows (for an integrator; `plans/ROADMAP.md` is not edited here)

Ids follow the UX track on `origin/main` (last row UX32) and the rows proposed by PR #705 (UX33 to UX37), so these start at UX38. Re-check the highest id when applying.

| ID   | Scope                                                                                                                                                                                                                               | Depends on       | State                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| UX38 | Research and Phase 0 for Copy as Markdown: report `research/copy-as-markdown.md`; then measure `ClipboardItem` (`text/html`, `text/markdown`, `supports()`) and `Ctrl+Alt+C` delivery in the VS Code webview, JCEF and a browser    | UX21             | Report done (2026-11-12); spike planned; after the next release (S) |
| UX39 | Repair the copy path: `useCopy` awaits and catches the clipboard write, announces success and failure through `announce()`, the message Copy and code Copy become keyboard-reachable buttons with names; no new `aria-live`         | none             | Not started; planned; after the next release (S)                    |
| UX40 | Copy as Markdown MVP: message menu (Markdown, plain text), code block copy with the info string, table copy (Markdown, CSV, TSV), the golden corpus of 40 answers and the round-trip property tests, views at 300 px and `axe-core` | UX39, UX36       | Not started; planned; after the next release (M)                    |
| UX41 | Rich text copy: `text/html` from the sanitised render plus `text/plain` Markdown in one `ClipboardItem`, JetBrains HTML flavor in `copyText` (only if Phase 0 allows)                                                               | UX38, UX40, UX28 | Not started; planned; after the next release (M)                    |
| UX42 | Copy selection as Markdown: source positions on rendered nodes, `webview/context` entry and palette command in VS Code, OSR menu entry for JetBrains                                                                                | UX38, UX40       | Not started; planned; after the next release (L)                    |
| UX43 | Copy a turn, a plan (checklist) and a diff (unified patch); conversation export to `.md` with header and redaction options, tool outputs omitted past 200 lines by default                                                          | UX40             | Not started; planned; after the next release (M)                    |
| UX44 | CLI parity: `/copy` (last assistant message, OSC 52 then platform helper) and `/export`; `cn -p` unchanged                                                                                                                          | UX31             | Not started; planned; after the next release (S)                    |

Open decisions row to add: "Copy as Markdown defaults (UX38 to UX44)": recommended, pending owner: Q1 to Q11 of `research/copy-as-markdown.md` section 10.
