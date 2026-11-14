# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

## Fixes

- Sessions no longer grow with every response; large saved sessions open again. Each request's full prompt was kept on the conversation and written to the session file on every save, so a long session grew with the square of its length (one reached 432 MB) until the chat window ran out of memory. Only the newest request's prompt is now kept in memory, for the feedback buttons, and none is written to disk; a session saved the old way has its prompts dropped as it is opened and is written small on the next save.
