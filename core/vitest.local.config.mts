import { mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";
const W = "D:/temp/wt-q25";
export default mergeConfig(base, {
  resolve: { alias: [
    { find: "@continuedev/config-yaml", replacement: `${W}/packages/config-yaml/src/index.ts` },
    { find: "@continuedev/openai-adapters", replacement: `${W}/packages/openai-adapters/src/index.ts` },
    { find: "@continuedev/llm-info", replacement: `${W}/packages/llm-info/src/index.ts` },
    { find: "@continuedev/config-types", replacement: `${W}/packages/config-types/src/index.ts` },
    { find: "@continuedev/fetch", replacement: `${W}/packages/fetch/src/index.ts` },
    { find: "@continuedev/terminal-security", replacement: `${W}/packages/terminal-security/src/index.ts` },
  ] },
  test: { server: { deps: { external: [/@aws-sdk/, /@smithy/] } } },
});
