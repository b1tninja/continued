# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

## Fixes

- Bedrock errors now name the cause when a model is refused for quota or account reasons. "Not available for this account" (what Bedrock answers when the account's tokens-per-minute quota for the model is 0, even with model access granted) points at Service Quotas instead of the model access page; "your account is currently being verified" (the first use of a region) says to wait; a throttled request says the quota is used up and that throttling on the very first request can mean a quota of 0.
- Costs now carry where their prices came from and as of when (Anthropic list prices, OpenAI pricing page, AWS Price List, the downloaded OpenRouter list, or a price you entered), for the cost displays to show. When Bedrock or Anthropic report that a request was served at a non-standard tier (flex, priority, batch), the cost breakdown says the figure is the standard-tier price and whether the actual charge is lower or higher.
- Adding Anthropic models reads image support and the scheduled retirement date from Anthropic's model list, and the Bedrock model list keeps image support and the legacy, extended-access and end-of-life dates Bedrock reports.
