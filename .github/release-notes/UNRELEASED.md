# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Custom… on every policy control.** The preset and each area's control end with **Custom…**, which opens a Custom policy editor on the Permissions page, started from the preset you are on: the five levels, the built-in rules, plan and question settings, your Never, Ask, Always and Always-on Never lists (add, remove, move, with a live preview against your recent calls), the MCP servers you trust, the MCP tools Plan mode may use, and a review of every change before it is saved. `floor:`, `mcpServers`, `plan.mcpTools`, `plan.allowTerminal` and `questions.delivery` in `permissions.yaml` can now be changed from the extension; until now they were edited by hand.

- **Custom policy: exact preview, and your custom set kept.** The review step shows the exact `permissions.yaml` the save will write, as a diff from the extension's own writer, before anything is written. A custom set of levels is kept with the preset it started from: the chip says **Custom (from Careful)**, and after choosing a preset the preset menu offers the set back. It is stored under `levels.custom`, which every terminal agent and extension version already accepts, so an older terminal agent still reads the file.

## Behaviour changes

- **A permission setting that loosens asks in your editor's own dialog.** Raising an area's level, switching a built-in rule off, removing an Always-on Never rule, trusting an MCP server, adding an MCP tool for Plan mode or offering the terminal in Plan mode now waits for a modal dialog in VS Code, or a notification with an Allow action in JetBrains IDEs, from the toolbar, **Settings, Tools** and the Custom policy editor alike. The Custom policy editor's "I understand" checkbox is gone: text in the page can send a click, the editor's dialog it cannot answer. Declining saves nothing, and the control shows what the file still says. In VS Code, raising a level already asked; that dialog now names each change. JetBrains IDEs now pass the policy settings messages to the extension's core, so the toolbar and Settings save there too.

## Fixes
