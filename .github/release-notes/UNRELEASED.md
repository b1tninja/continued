# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Drag files, folders, images and text into the chat input.** A workspace file dropped from the VS Code Explorer or an editor tab becomes an `@` file chip (read when you send, as if picked from the `@` list); a folder becomes an `@` folder chip, which is a search scope rather than the folder's whole contents. Images go through the image attachment (only for models that read images; at most 10 per message, 5 MB each), dropped text loses hidden characters, and a link is added as text without being fetched. Files that look like they hold secrets (`.env` files, keys and certificates, `.ssh` and cloud credential folders), files outside the workspace, and files from the operating system's file manager other than images are refused, and the input says which file and why; a refused file is never read. In VS Code, hold Shift while dragging. VS Code 1.140 and later stop Explorer and tab drops from reaching extension webviews (microsoft/vscode#339036); until VS Code fixes that, use `@` for workspace files. JetBrains IDEs are reported not to deliver drops to the chat (its browser is off-screen); use `@` there.

## Behaviour changes

## Fixes

- **The model's thinking shows again, live.** Claude Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos return their thinking empty unless asked, so the chat showed nothing until the answer; requests to them (on Anthropic's API and on Bedrock) now ask for summarized thinking (`thinking.display: "summarized"`, billed the same as the hidden thinking), including with reasoning off on the models that think anyway. Gemini 2.5 and later are asked for their thought summaries, which arrive as thinking rather than as part of the answer. OpenAI's reasoning summaries no longer appear twice. In the chat, thinking streams open and follows the newest text while the model thinks, then folds to one line, "Thought for 4.2s", that opens it again; the new **Keep Thinking Expanded** user setting (`ui.keepThinkingExpanded`) leaves it open. Later turns send Anthropic's API the same conversation as before (the summaries are not sent back); on Bedrock, which already sent thinking blocks back, they now carry the summary the model returned instead of empty text.
