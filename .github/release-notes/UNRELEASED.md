# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Drag files, folders, images and text into the chat input.** A workspace file dropped from the VS Code Explorer or an editor tab becomes an `@` file chip (read when you send, as if picked from the `@` list); a folder becomes an `@` folder chip, which is a search scope rather than the folder's whole contents. Images go through the image attachment (only for models that read images; at most 10 per message, 5 MB each), dropped text loses hidden characters, and a link is added as text without being fetched. Files that look like they hold secrets (`.env` files, keys and certificates, `.ssh` and cloud credential folders), files outside the workspace, and files from the operating system's file manager other than images are refused, and the input says which file and why; a refused file is never read. In VS Code, hold Shift while dragging. VS Code 1.140 and later stop Explorer and tab drops from reaching extension webviews (microsoft/vscode#339036); until VS Code fixes that, use `@` for workspace files. JetBrains IDEs are reported not to deliver drops to the chat (its browser is off-screen); use `@` there.

## Behaviour changes

- **Ctrl+Backspace no longer cancels anything.** Ctrl+Backspace (Cmd+Backspace on macOS, Alt+Backspace in JetBrains) used to stop the running response and reject a pending tool call, even when you were only deleting a word in the chat input, and work was lost that way. Backspace with any of those modifiers now only edits text, while a response is streaming too. Stop a response or a running terminal command with the **Stop** button, and reject a command with its **Reject** button. The `Shift+Ctrl+Backspace` (`Shift+Cmd+Backspace`) shortcut that rejects all diff changes in VS Code is unchanged.
