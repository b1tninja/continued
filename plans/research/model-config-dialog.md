# Model configuration dialog

Status: design plus a first slice (the "Configure..." dialog with Connection, Capabilities, Generation and Context & cost). Written 2026-11-13 against `main` 62277ea78. Owner request: "add more advanced model configuration dialogs, especially now that we support the prompt styles and tool call dialects". Principle: a good UI to view, change and check the model settings that already exist; new semantics come later and are listed as owner decisions.

## 1. What exists today (read from the code)

### 1.1 The model entry (`packages/config-yaml/src/schemas/models.ts`)

| Field                                                                                                                                                                                             | Where                                                            | Notes                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `model`, `provider`, `apiBase`, `apiKey`, `connection`, `contextLength`, `maxStopWords`, `roles`, `capabilities`, `toolDialect`, `env`, `useLegacyCompletionsEndpoint`, `useResponsesApi` | `baseModelFields` at :281                                        | `provider` is optional when `connection` names a provider account (`connectedModelSchema` :338)                                                                                                                                                                                                                              |
| `roles`                                                                                                                                                                                           | `modelRolesSchema` :30                                           | chat, autocomplete, embed, rerank, edit, apply, summarize, subagent, reviewer. Default `[chat, edit, apply, summarize]` (docs/reference.mdx :76)                                                                                                                                                                             |
| `capabilities`                                                                                                                                                                                    | `modelCapabilitySchema` :45                                      | `tool_use`, `image_input`, `next_edit`, any string. A list present means exactly those: `core/config/yaml/models.ts` :111-115 sets `tools: capabilities.includes("tool_use")`, so a list without `tool_use` turns tools off                                                                                                  |
| `defaultCompletionOptions`                                                                                                                                                                        | `completionOptionsSchema` :55                                    | contextLength, maxTokens, temperature, topP, topK, minP, presencePenalty, frequencyPenalty, stop, n, reasoning, reasoningBudgetTokens, promptCaching, omitSampling, stream, keepAlive                                                                                                                                        |
| `cacheBehavior`                                                                                                                                                                                   | :90                                                              | cacheSystemMessage, cacheConversation, ttl (`auto`, `5m`, `1h`)                                                                                                                                                                                                                                                              |
| `requestOptions`                                                                                                                                                                                  | :12                                                              | timeout (seconds, default 7200: `packages/fetch/src/getAgentOptions.ts` :12), connectTimeout (default 10), verifySsl, useSystemCa, caBundlePath (string or list), proxy, headers, extraBodyProperties, noProxy, clientCertificate                                                                                            |
| `embedOptions`                                                                                                                                                                                    | :100                                                             | maxChunkSize, maxBatchSize, embeddingPrefixes                                                                                                                                                                                                                                                                                |
| `chatOptions`                                                                                                                                                                                     | :133                                                             | baseSystemMessage, baseAgentSystemMessage, basePlanSystemMessage, toolOverrides (:138)                                                                                                                                                                                                                                       |
| `contextManagement`                                                                                                                                                                               | :150                                                             | autoCompactRatio, autoCompactTokens, subagent budget, requestBodyHints                                                                                                                                                                                                                                                       |
| `promptTemplates`                                                                                                                                                                                 | :218 (chat names from `templateSchema` :174)                     | apply, chat, edit, autocomplete                                                                                                                                                                                                                                                                                              |
| `autocompleteOptions`                                                                                                                                                                             | :195                                                             | 18 options                                                                                                                                                                                                                                                                                                                   |
| `routes`                                                                                                                                                                                          | `catalogRouteSchema` :232                                        | further accounts serving the same model                                                                                                                                                                                                                                                                                      |
| `toolDialect`                                                                                                                                                                                     | `TOOL_DIALECT_VALUES` :248                                       | auto, native, off and 23 markup dialects                                                                                                                                                                                                                                                                                     |
| Reasoning effort                                                                                                                                                                                  | `packages/config-yaml/src/schemas/index.ts` :103, :137           | Not on the model: `modeModels.<mode>.reasoningEffort` (off, low, medium, high)                                                                                                                                                                                                                                               |
| Provider-specific (`env.*`)                                                                                                                                                                       | `core/config/yaml/models.ts` :12-33                              | apiType, apiVersion, deployment, deploymentId (Azure); region, profile, accessKeyId, secretAccessKey, sessionToken, crossRegionInference, serviceTier, latency, guardrail\*, modelArn, mantlePathPrefix (Bedrock); projectId (Vertex); aiGatewaySlug, accountId (Cloudflare); maxTokensParam; `useLegacyCompletionsEndpoint` |
| Provider accounts                                                                                                                                                                                 | `providerInstanceSchema` :350, catalog `catalogModelSchema` :392 | `~/.continuous/providers.yaml` and `models.yaml` (docs/customize/model-catalog.mdx)                                                                                                                                                                                                                                          |

**Prompt styles.** There is no `promptStyle` setting. `PromptStyle` (`core/util/toolDialectPresets.ts` :78) is preset data per model family ("Data only: nothing reads this field to change what is sent"), with one row per family in `core/util/toolDialectPresetTable.ts` :22. What a model is actually sent is decided by `capabilities` plus the global `experimental.onlyUseSystemMessageTools` (`gui/src/redux/util/buildChatRequest.ts` :129-135, `core/llm/toolSupport.ts` :549): native tool definitions, or the code-block framework in the system message (`core/tools/systemMessageTools/buildToolsSystemMessage.ts`). So today's "prompt style" choice is native vs system message, per model through `capabilities`.

**Prices.** There is no price field. Budgets (`extensions/cli/src/budget/runBudget.ts` :66, :80) price through `costOf` (`core/util/costOf.ts` :91) and `calculateRequestCost` (`core/llm/utils/calculateRequestCost.ts` :703): built-in tables for Anthropic, Bedrock, Vertex Claude and OpenAI, and the downloaded OpenRouter list (`core/llm/utils/catalogPricing.ts`, `continuous models refresh`). `costOf` already accepts a `UserPrice` (:33) but only the shadow reviewer and loop cost pass one.

### 1.2 The UI today

| Piece                         | Where                                                                                                                                                                                             | What it does                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Gear on each picker row       | `gui/src/components/modelSelection/ModelSelect.tsx` :95-99 (before this change)                                                                                                                   | Navigated to the Models settings page                                                                                            |
| Gear on each role row         | `gui/src/pages/config/components/ModelRoleRow.tsx` :73-83, `useEditModel` in `components/mainInput/Lump/useEditBlock.ts`                                                                          | Opened config.yaml (or the block file)                                                                                           |
| Provider setup flow           | `gui/src/components/ProviderSetup/ProviderSetupFlow.tsx` :142                                                                                                                                     | Provider, key storage, model checklist, review; writes through `config/saveProviderModels` (`core/config/providerSetup.ts` :402) |
| Providers / accounts cards    | `gui/src/pages/config/components/ProvidersCard.tsx`, `ProviderInstancesCard.tsx`                                                                                                                  | Connections and providers.yaml accounts                                                                                          |
| Mode models table             | `gui/src/pages/config/components/ModeModelsTable.tsx`                                                                                                                                             | Models and reasoning effort per mode                                                                                             |
| Test connection               | `gui/src/forms/OpenAICompatConnectionTester.tsx`, `BedrockConnectionTester.tsx`; core `core/util/openaiCompatTest.ts` :233; CLI `continuous test-connection` (`extensions/cli/src/index.ts` :551) | Lists models, sends one probe with a made-up tool, offers "Turn on recovery" (`config/setToolDialect`)                           |
| Tool dialect one-click        | `core/config/yaml/saveToolDialect.ts`, leak notice `gui/src/components/mainInput/ToolDialectNotice.tsx`                                                                                           | Sets `toolDialect` on one model                                                                                                  |
| Global "system message tools" | `gui/src/pages/config/sections/UserSettingsSection.tsx` :64                                                                                                                                       | One switch for all models                                                                                                        |
| Writer                        | `core/util/paths.ts` `editConfigFile` :593, `editConfigYaml` :490; `core/util/yamlEdit.ts` `editYamlText`                                                                                         | `parseDocument` edit: comments, key order, unknown keys and CRLF kept; one `.bak` for files in `~/.continuous`                   |
| Secrets                       | `config/setSecret` (`core/protocol/core.ts`), `core/config/secretStorage.ts`, `core/util/unresolvedSecrets.ts`                                                                                    | Secure storage or `~/.continuous/.env`; config.yaml holds `${{ secrets.NAME }}`                                                  |

Everything in 1.1 except the fields the provider flow writes (provider, model, apiBase, key, roles for new models) and `toolDialect` (one-click) was editable only by hand.

## 2. The dialog

### 2.1 Entry points

- The gear on each model in the chat model picker, and the gear on each role row of Models settings, now open **Configure <model>**. Both had an accessible name only in the picker; the role row gear now has `aria-label="Configure <model>"`.
- The dialog has **Open file** in its header, so the old behaviour is one click away.

### 2.2 Layout (sidebar width; tabs wrap)

```
+------------------------------------------------------------+
| Configure Qwen Coder                                    [x] |
| User config: ~/.continuous/config.yaml   Open file          |
| [Connection] Capabilities  Generation  Context & cost       |
|------------------------------------------------------------|
| Provider        [vllm                                   ]   |
| Model id        [qwen3-coder                            ]   |
| API base        [http://gpu-box:8000/v1                 ]   |
| API key         Stored as the secret QWEN_KEY.              |
|                 (o) Keep  ( ) Use a secret  ( ) Remove      |
| Request timeout [            Default: 7200             ]   |
| Connect timeout [            Default: 10               ]   |
| Proxy           [  Default: HTTPS_PROXY / HTTP_PROXY   ]   |
| Verify TLS      [Default (on)              v]               |
| Headers         X-Team [tools        ] Remove               |
|                 Authorization [hidden (kept)  ] Remove      |
|                 [Add header]                                |
| Test connection [Test connection]  (unsaved values)        |
|------------------------------------------------------------|
|                                  [Cancel] [Review changes]  |
+------------------------------------------------------------+
```

Capabilities:

```
| Roles      [x] Default (chat, edit, apply, summarize)       |
| How tools are sent (prompt style)                           |
|   (o) Auto-detect (native)  ( ) Native  ( ) System message  |
|   Known family Qwen3-Coder: asks for native tool calls ...  |
|   Sent as an API tool definition (read_file shown):         |
|   { "tools": [ { "type": "function", ... } ] }              |
| Image input  (o) Auto-detect ( ) Yes ( ) No                 |
| Tool calls written as text  [Qwen XML (qwen-xml)      v]    |
|   Qwen3-Coder's markup. A reply in this form runs read_file:|
|   <tool_call><function=read_file><parameter=filepath>...    |
```

Context & cost:

```
| Context length  [ 131072 ]                                  |
| Prompt caching  [Default v]   Cache lifetime [Default v]    |
| Price (used by budgets)                                     |
|   $3.00 in / $15.00 out per million tokens, built-in table. |
|   or: No price is known for vllm/qwen3-coder, so a dollar   |
|   budget (--max-budget-usd) refuses to run on it ...        |
```

Review:

```
| Review the change to config.yaml                            |
|   The key is stored as QWEN_NEW in secure storage, not in   |
|   config.yaml.                                              |
|     - name: Qwen Coder                                      |
| -     apiKey: ${{ secrets.QWEN_KEY }}                        |
| +     apiKey: ${{ secrets.QWEN_NEW }}                        |
|       defaultCompletionOptions:                             |
| -       temperature: 0.2 # tuned                             |
| +       temperature: 0.7 # tuned                             |
|   Comments and every setting not shown here are kept.       |
|                                          [Back] [Save]      |
```

Planned tabs, not in the first slice: **Templates & system message** (`promptTemplates`, `chatOptions.base*SystemMessage`, `toolOverrides`), **Autocomplete** and **Embeddings** (shown only when the role applies), **Advanced (YAML)** (the entry as text, parsed and validated, written through the same writer).

### 2.3 Behaviour

- **Prefilled from the entry as written**, not from the loaded model, so a value inherited from a provider account or default is not mistaken for one the user set. A model whose `connection:` names an account says so: a value set here wins for this model only.
- **Defaults are placeholders**, never written. Only fields whose input changed become patch operations; clearing a field removes the key, and a map left empty is removed.
- **Validation** per field while typing (`aria-invalid`, message linked with `aria-describedby`), again on Review in the webview, and authoritatively in core: the same rules (`core/config/modelEdit/modelEditFields.ts`) plus the zod schema of the whole entry. A tab with an error is marked and Review jumps to it.
- **Review shows the YAML diff** core computed for the exact text it will write, with two lines of context and credentials masked. Save sends the preview's SHA-256; core refuses with "changed since the preview" if the file moved, and the dialog asks for a new review.
- **Round trip**: the writer is `editYamlText`, so comments, key order, anchors, CRLF and unknown keys survive. Core only accepts patches to the listed paths, request headers and `capabilities`; anything else is refused with a message.
- **Secrets**: the dialog never receives a plain credential (plain values under credential-like keys are replaced with `••••••`; secret references are returned as names). A key is written to config.yaml only as `${{ secrets.NAME }}`; a typed value goes to `config/setSecret` (secure storage or `.env`) before the config is saved, and if storing fails nothing is saved. Credential headers (`Authorization`, `*api-key*`, `*token*`, `*secret*`, `Cookie`, ...) accept only a reference; an existing plain one stays as written unless replaced.
- **Scope**: the file is the one every GUI save writes (`getEditableConfigYamlPath`, the selected config). The header says "User config" (inside `~/.continuous`) or "Workspace config" and shows the path. A model from a block file, a catalog `from:`, a `uses:` entry, a hub assistant or a non-local profile is shown read-only with the reason and Open file.
- **Test connection** reuses the existing testers with the unsaved values: OpenAI-compatible and Anthropic through `OpenAICompatConnectionTester` (key: the one being typed, else the loaded model's key, never shown), Bedrock through `BedrockConnectionTester` (region, profile).
- **Accessibility**: `role="dialog"`, `aria-modal`, labelled by its heading; WAI-ARIA tabs with roving `tabindex` and Left/Right/Home/End; every input has a label; radio groups are named; previews and the diff are focusable regions; the diff marks lines as "added:"/"removed:" for screen readers rather than by colour alone; Escape closes (app dialog).
- **JetBrains**: the three new messages are in `MessageTypes.kt`, so the same webview dialog works there. JetBrains has no secure storage (`plans/model-config-ux.md` 9), so "Use a secret" falls back to `.env` there.

### 2.4 CLI parity

There is no `continuous models edit` today; `continuous models` is the OpenRouter list (`extensions/cli/src/commands/models.ts` :190). The core functions are surface-free (`editModelBlockText`, `previewModelEditText`), so a CLI can reuse them. Proposed (owner decision D5): `continuous model show <name>` (masked entry) and `continuous model set <name> <path>=<value> ... [--dry-run]` printing the same diff. Until then, the same change by hand is the YAML in the Review step.

## 3. Owner decisions

| #   | Question                                                                                                                                | Recommendation                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Make the prompt style a per-model setting (`toolPrompt: native \| system-message \| <family form>`) instead of riding on `capabilities` | Not yet. The family forms are data only and unmeasured (ROADMAP Q17, Q24, TR10). The dialog shows the preset's recommendation and the real choice (native or system message). Revisit when Q17 measures a prompted path |
| D2  | A price field on the model (`pricing: { input, output, cacheRead, cacheWrite }` per MTok)                                               | Yes, small: `costOf` already takes a `UserPrice`; wire it from the model so budgets work for local and unlisted models. The dialog's Context & cost tab is where it goes                                                |
| D3  | Edit the provider account (providers.yaml) from this dialog, or only the model                                                          | Only the model; link to the account card. One file per save keeps the review honest                                                                                                                                     |
| D4  | Edit models defined in block files and catalogs (`from:`)                                                                               | Later: the writer works per file, so it is the same code pointed at `sourceFile`; the review must then name that file                                                                                                   |
| D5  | CLI command name and shape (2.4)                                                                                                        | `continuous model show/set`, not under `models` (that is the OpenRouter list)                                                                                                                                           |
| D6  | Allow a plaintext key from the dialog at all                                                                                            | No. The provider flow still offers "inline"; the dialog does not                                                                                                                                                        |
| D7  | Reasoning effort per model (today only per mode)                                                                                        | Keep per mode; the dialog links to the mode table                                                                                                                                                                       |

## 4. First slice (this PR)

Core:

- `core/config/modelEdit/modelEditFields.ts`: field registry, masking, validation, patch application (webview-safe).
- `core/config/modelEdit/modelBlockEdit.ts`: read, preview (diff, hash) and save for the editable config.
- Messages `config/getModelBlock`, `config/previewModelEdit`, `config/saveModelEdit` (protocol, pass-through, JetBrains list, handlers; save reloads the config).

GUI (`gui/src/components/ModelConfig/`): `ModelConfigDialog.tsx`, `modelConfigForm.ts`, `toolPreview.ts`, `useModelConfigDialog.tsx`; the two gears now open it.

Covered fields: provider, model, apiBase, apiKey (secret reference), env.region / profile / projectId / deployment / apiVersion / apiType (shown per provider), requestOptions.timeout / connectTimeout / proxy / noProxy / verifySsl / useSystemCa / caBundlePath / headers, roles, capabilities (tool_use, image_input; other names kept), toolDialect, defaultCompletionOptions.temperature / topP / topK / presencePenalty / frequencyPenalty / maxTokens / stop / reasoning / reasoningBudgetTokens / promptCaching, contextLength, cacheBehavior.cacheSystemMessage / cacheConversation / ttl.

Not covered yet (still kept untouched on save, and editable by hand): `name` (rename), `connection`, `routes`, `maxStopWords`, `useLegacyCompletionsEndpoint`, `useResponsesApi`, defaultCompletionOptions.contextLength / minP / n / stream / keepAlive / omitSampling, requestOptions.extraBodyProperties / clientCertificate, env credentials (accessKeyId, secretAccessKey, sessionToken: shown nowhere yet, never sent) and the other env keys (deploymentId, crossRegionInference, serviceTier, latency, guardrailIdentifier, guardrailVersion, modelArn, mantlePathPrefix, maxTokensParam, aiGatewaySlug, accountId), `chatOptions` (system messages, toolOverrides), `promptTemplates`, `embedOptions`, `autocompleteOptions`, `contextManagement`, catalog `variants`, raw YAML.

## 5. Follow-ups, in order

1. Advanced (YAML) tab: the entry as text, validated with the schema, written through the same preview and save.
2. Templates & system message tab (`chatOptions`, `promptTemplates`, tool overrides), with the default system message shown as the placeholder.
3. Autocomplete and Embeddings tabs, shown when the role applies.
4. Price field (D2), then show it and its source in the Context & cost tab.
5. The remaining env keys (Bedrock service tier, latency, guardrails, cross-region inference; Azure deploymentId) and env credentials as secret references.
6. Edit models in block files and catalog entries (D4).
7. CLI `continuous model show/set` (D5).
8. Rename (`name`), updating `modeModels` and selected-model references in the same save.
9. Keep the Test connection result per model in the dialog (the probe status from `openaiCompat/probeStatus`).

## 6. Not verified

- Run in a real VS Code or JetBrains window: only unit and component tests ran (no screenshot harness run).
- The app dialog container (`gui/src/components/dialogs/index.tsx`) does not trap focus; the dialog sets its own role and moves focus to the first tab, but Tab can leave it.
- `useSystemCa` default text is from docs/reference.mdx :138, not from code.
