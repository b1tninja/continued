import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../../llms/bedrockHelpers";
import { decodeStream, loadCorpus } from "./corpus";

/**
 * The text filters exist twice, in core/llm/llms/bedrockHelpers.ts and in
 * packages/openai-adapters/src/dialects/textFilters.ts, and core may not
 * import the adapters package. This runs the replies observed live on Bedrock
 * through both copies, the adapters one loaded by absolute path as the other
 * corpus tests do, so the copies cannot drift apart.
 */
const ADAPTERS = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects/textFilters.ts",
);

type Split = { content: string; reasoning: string };
interface Filters {
  holdBackDsmlMarker(b: string): { emit: string; hold: string };
  flushDsmlHold(h: string): string;
  leaksDsmlMarker(m: string): boolean;
  cleanReplyText(m: string, t: string): Split;
  createThinkingTagSplitter(m: string):
    | {
        push(t: string): Split;
        flush(): Split;
      }
    | undefined;
}

async function copies(): Promise<[string, Filters][]> {
  const adapters = (await import(/* @vite-ignore */ ADAPTERS)) as Filters;
  return [
    ["adapters", adapters],
    ["core", core as unknown as Filters],
  ];
}

/** What a stream handler shows for one block: the DSML hold-back, then the splitter. */
function streamVisible(f: Filters, model: string, chunks: string[]): Split {
  const splitter = f.createThinkingTagSplitter(model);
  const filter = f.leaksDsmlMarker(model);
  let hold = "";
  const out: Split = { content: "", reasoning: "" };
  const take = (t: string) => {
    const s = splitter ? splitter.push(t) : { content: t, reasoning: "" };
    out.content += s.content;
    out.reasoning += s.reasoning;
  };
  for (const chunk of chunks) {
    let text = chunk;
    if (filter) {
      const split = f.holdBackDsmlMarker(hold + text);
      hold = split.hold;
      text = split.emit;
    }
    take(text);
  }
  if (hold) take(f.flushDsmlHold(hold));
  if (splitter) {
    const s = splitter.flush();
    out.content += s.content;
    out.reasoning += s.reasoning;
  }
  return out;
}

const ANSWER = 'The file `docs/a.md` contains the word "hello".';

describe("the DSML and thinking-tag filters on replies observed live", () => {
  it("drops the DSML fragment of a deepseek.v3.2 reply under every chunking", async () => {
    const fixture = loadCorpus().find(
      (f) => f.id === "deepseek-v32-bedrock-dsml-fragment",
    )!;
    const model = "deepseek.v3.2";
    const visible = "I'll read the src/main.ts file for you.\n\n";
    expect(fixture.text).toContain("DSML");
    for (const [name, f] of await copies()) {
      for (const stream of fixture.streams) {
        expect(
          streamVisible(f, model, decodeStream(stream)),
          `${name}/${stream.label}`,
        ).toEqual({ content: visible, reasoning: "" });
      }
      // The non-streaming path.
      expect(f.cleanReplyText(model, fixture.text), name).toEqual({
        content: visible,
        reasoning: "",
      });
    }
  });

  it("drops the fragment whatever tag follows the marker, and a split ASCII-bar form", async () => {
    for (const [name, f] of await copies()) {
      expect(
        f.cleanReplyText("deepseek.v3.2", "a <｜DSML｜invoke name=x>").content,
        name,
      ).toBe("a ");
      expect(
        f.cleanReplyText("us.deepseek.v3.2", "a <|DSML|tool_calls").content,
        name,
      ).toBe("a ");
      expect(f.cleanReplyText("deepseek.v3.2", "a < b").content, name).toBe(
        "a < b",
      );
      expect(
        f.cleanReplyText("meta.llama3", "a <｜DSML｜x").content,
        name,
      ).toBe("a <｜DSML｜x");
    }
  });

  it("lifts the leaked <think> block of moonshot.kimi-k2-thinking into reasoning under every chunking", async () => {
    const fixture = loadCorpus().find(
      (f) => f.id === "kimi-k2-thinking-bedrock-think-tags-in-text",
    )!;
    const model = "moonshot.kimi-k2-thinking";
    for (const [name, f] of await copies()) {
      for (const stream of fixture.streams) {
        const shown = streamVisible(f, model, decodeStream(stream));
        expect(shown.content.trim(), `${name}/${stream.label}`).toBe(ANSWER);
        expect(shown.reasoning.trim(), `${name}/${stream.label}`).toBe(ANSWER);
      }
      const whole = f.cleanReplyText(model, fixture.text);
      expect(whole.content.trim(), name).toBe(ANSWER);
      expect(whole.reasoning.trim(), name).toBe(ANSWER);
      // Models that do not write the tags are left alone.
      expect(
        f.cleanReplyText("moonshot.kimi-k2.5", fixture.text).content,
        name,
      ).toBe(fixture.text);
    }
  });

  it("strips thinking tags for the same ids in both copies, as before the preset read", async () => {
    // The regexes the filters hardcoded before they read the preset row.
    const legacy = (id: string) =>
      /nova-(pro|lite|micro|premier)/i.test(id)
        ? "<thinking>"
        : /kimi-k2-thinking/i.test(id)
          ? "<think>"
          : undefined;
    const ids = [
      "amazon.nova-pro-v1:0",
      "us.amazon.nova-lite-v1:0",
      "amazon.nova-micro-v1:0",
      "amazon.nova-premier-v1:0",
      "us.amazon.nova-2-lite-v1:0",
      "amazon.nova-2-pro-preview",
      "moonshot.kimi-k2-thinking",
      "moonshotai/kimi-k2-thinking",
      "moonshot.kimi-k2.5",
      "moonshotai/kimi-k2-instruct",
      "moonshot.kimi-k3",
      "qwen.qwen3-32b-v1:0",
      "zai.glm-4.7",
      "minimax.minimax-m2",
      "deepseek.v3.2",
      "nvidia.nemotron-super-3-120b",
      "meta.llama3-3-70b-instruct-v1:0",
      "anthropic.claude-sonnet-4",
    ];
    const text = "<thinking>a</thinking>x<think>b</think>y";
    for (const id of ids) {
      for (const [name, f] of await copies()) {
        const shown = f.cleanReplyText(id, text);
        const want = legacy(id);
        if (want === "<thinking>") {
          expect(shown, `${name}/${id}`).toEqual({
            content: "x<think>b</think>y",
            reasoning: "a",
          });
        } else if (want === "<think>") {
          expect(shown, `${name}/${id}`).toEqual({
            content: "<thinking>a</thinking>xy",
            reasoning: "b",
          });
        } else {
          expect(shown, `${name}/${id}`).toEqual({
            content: text,
            reasoning: "",
          });
        }
      }
    }
  });
});
