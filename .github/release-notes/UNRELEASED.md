# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Session file size in the context meter.** The context meter's details show the session's file size on disk and its item count, for example "Session file 3.4 MB, 812 items". Past 50 MB the line turns to the warning colour and says why: every save rewrites the whole file, so a large session saves and opens slowly. Core logs a warning once per session when a save passes 50 MB, and logs any save that takes a second or more. CI now drives a 500-request agent session through the GUI and fails if the saved session grows faster than linearly, if one save passes 40 MB, or if any history item field grows with the length of the session, which is how the prompt-log growth went unnoticed.

## Behaviour changes

## Fixes

- Sessions no longer grow with every response; large saved sessions open again. Each request's full prompt was kept on the conversation and written to the session file on every save, so a long session grew with the square of its length (one reached 432 MB) until the chat window ran out of memory. Only the newest request's prompt is now kept in memory, for the feedback buttons, and none is written to disk; a session saved the old way has its prompts dropped as it is opened and is written small on the next save.
