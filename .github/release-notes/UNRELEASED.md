# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Test connection checks the model id.** For Anthropic and OpenAI (and OpenAI-compatible servers that have a models list), Test connection, in the add-model form and `continuous test-connection --model`, asks the provider about the configured id with `GET /v1/models/{id}`. An id the key cannot reach is named with close matches from the list ("Did you mean claude-opus-5-5?"); Anthropic's answer adds the context window, maximum output, image and PDF input, thinking types and deprecation dates, and OpenAI's adds a shutdown date. A refused key, a rate limit, a network failure and an endpoint without a models API are told apart and reported as "not checked"; none of them fails the connection or a chat request.

## Behaviour changes

- **The selected Anthropic or OpenAI chat model's details are refreshed from its own provider**, with Model information updates on **Automatic** (the default). A few seconds after you select the model, then once per refresh interval (24 hours by default), Continuous sends one `GET /v1/models/{id}` to the API base configured for that model, with your key and `requestOptions`. No other host is contacted, only the selected model is asked about, and nothing waits for the answer. The answer is kept in `model-catalog/provider-<provider>-<hash>.json` (the hash covers the API base and key; the key is not written) and supplies the context window and default maximum output where your config does not set them, ahead of the bundled model data; Anthropic's built-in default of 8192 output tokens is never raised by it. A deprecation, retirement or shutdown date shows as the warning chip beside the model picker (now for OpenAI models too). A refused key or a failure leaves the bundled data in use and retries later; an endpoint without a models API is not asked again in that session. **Only when I ask** limits this to Test connection; **Off** sends nothing and ignores kept answers.

## Fixes

- Bedrock errors now name the cause when a model is refused for quota or account reasons. "Not available for this account" (what Bedrock answers when the account's tokens-per-minute quota for the model is 0, even with model access granted) points at Service Quotas instead of the model access page; "your account is currently being verified" (the first use of a region) says to wait; a throttled request says the quota is used up and that throttling on the very first request can mean a quota of 0.
- Costs now carry where their prices came from and as of when (Anthropic list prices, OpenAI pricing page, AWS Price List, the downloaded OpenRouter list, or a price you entered), for the cost displays to show. When Bedrock or Anthropic report that a request was served at a non-standard tier (flex, priority, batch), the cost breakdown says the figure is the standard-tier price and whether the actual charge is lower or higher.
- Adding Anthropic models reads image support and the scheduled retirement date from Anthropic's model list, and the Bedrock model list keeps image support and the legacy, extended-access and end-of-life dates Bedrock reports.
