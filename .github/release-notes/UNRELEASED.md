# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- A turn is saved while it runs. Your message is saved when you send it, each tool result when the tool finishes, and the answer every few seconds as it streams, so if the window or VS Code dies in the middle of a turn, the chat reopens with all of that and offers Resume.

## Behaviour changes

- Chats are saved as an append-only log (`sessions/<id>.jsonl`). Each save adds only what changed, instead of rewriting the whole chat file. Tool outputs over 4 KB, and any other text or image over 16 KB, are stored once in `sessions/<id>/blobs/`, so a tool output is no longer kept twice and a file read twice is stored once. A chat saved the old way (`<id>.json`) is converted the next time it is saved, and the old file is removed only after the new one reads back the same. "Save chats as an append-only log" in Settings turns this off, which converts chats back to `.json` as they are saved. The `cn` CLI still writes `.json`, and reads both.

## Fixes

- Sessions no longer grow with every response; large saved sessions open again. Each request's full prompt was kept on the conversation and written to the session file on every save, so a long session grew with the square of its length (one reached 432 MB) until the chat window ran out of memory. Only the newest request's prompt is now kept in memory, for the feedback buttons, and none is written to disk; a session saved the old way has its prompts dropped as it is opened and is written small on the next save.
