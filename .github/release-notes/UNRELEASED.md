# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

## Fixes

- **A broken conversation history no longer fails every later request.** Before a request is sent, the history is now checked and repaired the same way for every provider: a turn left empty by a stopped or failed reply is dropped, along with reasoning that had no answer after it; a tool call with no result (for example one whose result was lost) is answered as cancelled; a tool result whose call is gone is sent as text; a message you typed while tools were running goes after their results; and a tool call missing its id or name is fixed or left out. Previously such a history could be refused with a 400 on every message after it (Anthropic: "tool_use ids were found without tool_result blocks immediately after"), so the session was stuck. A history that is already valid is sent byte for byte as before, so prompt caching is unaffected. Cohere, watsonx and vLLM also get turns of the same role joined, and a user turn first, because their chat templates require turns to alternate.
- Anthropic (native and through Vertex AI) no longer sends a tool result for a tool call it left out.
- watsonx no longer changes the messages it sends, so a retry after a dropped connection, or a fallback model, no longer sends tool results without their ids.
- Ollama, watsonx, SageMaker and Cloudflare Workers AI no longer send the model's reasoning as a message with the unsupported role `thinking`.
- Gemini no longer sends an empty turn, an image given as a web link (which it can't take inline; the image is now left out with a warning), or a tool call without a name.
- The AI SDK path now sends cut-off or empty tool-call arguments as `{}` instead of as a raw string, an assistant's text parts as text, and images as image parts.
- The CLI no longer sends the model's reasoning back as assistant text, which showed it as part of the answer and made two assistant turns in a row. The CLI's Cohere connection no longer drops the last message from the request it retries.
