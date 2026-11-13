# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Drag files, folders, images and text into the chat input.** A workspace file dropped from the VS Code Explorer or an editor tab becomes an `@` file chip (read when you send, as if picked from the `@` list); a folder becomes an `@` folder chip, which is a search scope rather than the folder's whole contents. Images go through the image attachment (only for models that read images; at most 10 per message, 5 MB each), dropped text loses hidden characters, and a link is added as text without being fetched. Files that look like they hold secrets (`.env` files, keys and certificates, `.ssh` and cloud credential folders), files outside the workspace, and files from the operating system's file manager other than images are refused, and the input says which file and why; a refused file is never read. In VS Code, hold Shift while dragging. VS Code 1.140 and later stop Explorer and tab drops from reaching extension webviews (microsoft/vscode#339036); until VS Code fixes that, use `@` for workspace files. JetBrains IDEs are reported not to deliver drops to the chat (its browser is off-screen); use `@` there.

## Behaviour changes

## Fixes

- Bedrock errors now name the cause when a model is refused for quota or account reasons. "Not available for this account" (what Bedrock answers when the account's tokens-per-minute quota for the model is 0, even with model access granted) points at Service Quotas instead of the model access page; "your account is currently being verified" (the first use of a region) says to wait; a throttled request says the quota is used up and that throttling on the very first request can mean a quota of 0.
- Costs now carry where their prices came from and as of when (Anthropic list prices, OpenAI pricing page, AWS Price List, the downloaded OpenRouter list, or a price you entered), for the cost displays to show. When Bedrock or Anthropic report that a request was served at a non-standard tier (flex, priority, batch), the cost breakdown says the figure is the standard-tier price and whether the actual charge is lower or higher.
- Adding Anthropic models reads image support and the scheduled retirement date from Anthropic's model list, and the Bedrock model list keeps image support and the legacy, extended-access and end-of-life dates Bedrock reports.
- Bedrock no longer fails with "no content in assistant message before conversational turn change". A turn that converts to nothing (a reply stopped or failed before any text, reasoning a non-Claude model can't take back, a tool call without an id, a user message whose context or image rendered empty) is now left out and the turns around it are joined, so the request keeps the alternating roles Converse requires. The CLI, which sent two messages of the same role in that case, gets the same repair. A history that was already valid is sent byte for byte as before, so prompt caching is unaffected.
