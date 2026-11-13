# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Drag files, folders, images and text into the chat input.** A workspace file dropped from the VS Code Explorer or an editor tab becomes an `@` file chip (read when you send, as if picked from the `@` list); a folder becomes an `@` folder chip, which is a search scope rather than the folder's whole contents. Images go through the image attachment (only for models that read images; at most 10 per message, 5 MB each), dropped text loses hidden characters, and a link is added as text without being fetched. Files that look like they hold secrets (`.env` files, keys and certificates, `.ssh` and cloud credential folders), files outside the workspace, and files from the operating system's file manager other than images are refused, and the input says which file and why; a refused file is never read. In VS Code, hold Shift while dragging. VS Code 1.140 and later stop Explorer and tab drops from reaching extension webviews (microsoft/vscode#339036); until VS Code fixes that, use `@` for workspace files. JetBrains IDEs are reported not to deliver drops to the chat (its browser is off-screen); use `@` there.

- **Custom… on every policy control.** The preset and each area's control end with **Custom…**, which opens a Custom policy editor on the Permissions page, started from the preset you are on: the five levels, the built-in rules, plan and question settings, your Never, Ask, Always and Always-on Never lists (add, remove, move, with a live preview against your recent calls), the MCP servers you trust, the MCP tools Plan mode may use, and a review of every change before it is saved. `floor:`, `mcpServers`, `plan.mcpTools`, `plan.allowTerminal` and `questions.delivery` in `permissions.yaml` can now be changed from the extension; until now they were edited by hand.

## Behaviour changes
