# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

- **IDGAF no longer denies or asks about anything, including rules you set as Never.** At IDGAF the permission layer lets every tool call through: Never (`deny`) and always-on (`floor`) rules, the CLI's `exclude` lists and `--exclude`, protected paths and secret files, the safety floor, commands that hide what they run, writes to paths built at run time, the locked policy and configuration files, the tainted-session rule and changed MCP tool definitions no longer stop a call, and nothing waits for an answer. In `cn -p` and `cn serve`, tools that ask or are excluded are offered at IDGAF, and a loop worker of an `--auto` parent runs at the parent's levels. What would have stopped each call is recorded in its decision and in the audit trail, never shown to the model. A tool you switched off, Plan mode, an `--agent` file's tool list, a subagent's limits and hooks you wrote yourself still apply. Below IDGAF nothing changed.

## Fixes

- **The model's thinking shows again, live.** Claude Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos return their thinking empty unless asked, so the chat showed nothing until the answer; requests to them (on Anthropic's API and on Bedrock) now ask for summarized thinking (`thinking.display: "summarized"`, billed the same as the hidden thinking), including with reasoning off on the models that think anyway. Gemini 2.5 and later are asked for their thought summaries, which arrive as thinking rather than as part of the answer. OpenAI's reasoning summaries no longer appear twice. In the chat, thinking streams open and follows the newest text while the model thinks, then folds to one line, "Thought for 4.2s", that opens it again; the new **Keep Thinking Expanded** user setting (`ui.keepThinkingExpanded`) leaves it open. Later turns send Anthropic's API the same conversation as before (the summaries are not sent back); on Bedrock, which already sent thinking blocks back, they now carry the summary the model returned instead of empty text.
