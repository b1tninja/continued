/**
 * Recovery of tool calls written as text, for the OpenAI-compatible chat
 * completions stream (Ollama, llama.cpp, vLLM, LM Studio, Strata, ...). The
 * same hold-and-decide stage the Bedrock handlers use: text content goes
 * through `recovery`, a held reply is judged when the reply ends, and calls
 * are made only when the server made no tool call of its own.
 */
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
} from "openai/resources/index";
import {
  type DialectTool,
  RECOVER_TEXT_TOOL_CALLS_FIELD,
  type RecoveredCall,
  type RecoveryEvent,
} from "./qwenXml.js";
import {
  createTextToolRecovery,
  recoveredCallId,
  recoverFromText,
  type TextToolRecovery,
} from "./recovery.js";

/** The request's function tools, as the dialects see them. */
export function dialectToolsFromChat(
  tools: ChatCompletionCreateParams["tools"] | undefined,
): DialectTool[] {
  const out: DialectTool[] = [];
  for (const t of tools ?? []) {
    const fn = (t as { function?: { name?: string; parameters?: unknown } })
      .function;
    if (fn?.name) out.push({ name: fn.name, parameters: fn.parameters });
  }
  return out;
}

/**
 * The recovery stage for a chat request, or undefined when it is off or no
 * tools were offered. Removes the switch's field from the body so it is never
 * sent to the server.
 */
export function takeChatRecovery(
  body: ChatCompletionCreateParams,
  env?: Record<string, string | undefined>,
): {
  stage: TextToolRecovery | undefined;
  tools: DialectTool[];
  ask: Record<string, unknown>;
} {
  const fields = body as unknown as Record<string, unknown>;
  const ask = {
    [RECOVER_TEXT_TOOL_CALLS_FIELD]: fields[RECOVER_TEXT_TOOL_CALLS_FIELD],
  };
  delete fields[RECOVER_TEXT_TOOL_CALLS_FIELD];
  const tools = dialectToolsFromChat(body.tools);
  const stage =
    tools.length > 0
      ? createTextToolRecovery(body.model, tools, ask, env)
      : undefined;
  return { stage, tools, ask };
}

function withContent(
  chunk: ChatCompletionChunk,
  content: string,
): ChatCompletionChunk {
  const choice = chunk.choices[0];
  const delta = { ...choice.delta } as Record<string, unknown>;
  if (content) delta.content = content;
  else delete delta.content;
  return {
    ...chunk,
    choices: [{ ...choice, delta } as ChatCompletionChunk.Choice],
  };
}

function callChunk(
  base: ChatCompletionChunk,
  call: RecoveredCall,
  index: number,
): ChatCompletionChunk {
  return {
    ...base,
    usage: undefined,
    choices: [
      {
        index: 0,
        finish_reason: null,
        delta: {
          tool_calls: [
            {
              index,
              id: recoveredCallId(index),
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            },
          ],
        },
      },
    ],
  } as ChatCompletionChunk;
}

/**
 * `source` with recovery applied. Chunks without a choice (usage) and chunks
 * without text pass through; text is held by `recovery`; at the chunk that
 * finishes the reply the held text is judged, and recovered calls come before
 * a finish_reason of "tool_calls".
 */
export async function* recoverChatStream(
  source: AsyncIterable<ChatCompletionChunk>,
  recovery: TextToolRecovery,
): AsyncGenerator<ChatCompletionChunk> {
  const recovered: RecoveredCall[] = [];
  let sawToolCalls = false;
  let last: ChatCompletionChunk | undefined;
  let finished = false;

  const take = (events: RecoveryEvent[]): string => {
    let text = "";
    for (const e of events) {
      if (e.type === "call") recovered.push(e.call);
      else text += e.text;
    }
    return text;
  };
  function* calls(base: ChatCompletionChunk) {
    if (sawToolCalls) return;
    for (const [i, call] of recovered.entries()) {
      yield callChunk(base, call, i);
    }
  }

  for await (const chunk of source) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      yield chunk;
      continue;
    }
    last = chunk;
    if (choice.delta?.tool_calls?.length) sawToolCalls = true;
    const content = choice.delta?.content;
    let text = typeof content === "string" ? content : undefined;
    if (text) text = take(recovery.push(text));
    if (!choice.finish_reason) {
      if (typeof content !== "string") yield chunk;
      else if (text || Object.keys(choice.delta).some((k) => k !== "content")) {
        yield withContent(chunk, text ?? "");
      }
      continue;
    }
    finished = true;
    text = (text ?? "") + take(recovery.end());
    if (sawToolCalls || recovered.length === 0) {
      yield withContent(chunk, text);
      continue;
    }
    yield withContent(
      {
        ...chunk,
        usage: undefined,
        choices: [{ ...choice, finish_reason: null }],
      },
      text,
    );
    yield* calls(chunk);
    yield {
      ...chunk,
      choices: [{ ...choice, delta: {}, finish_reason: "tool_calls" }],
    } as ChatCompletionChunk;
  }
  if (!finished && last) {
    const text = take(recovery.end());
    if (text) yield withContent({ ...last, usage: undefined }, text);
    yield* calls(last);
  }
}

/** A whole (non-streamed) reply with recovery applied, in place. */
export function recoverChatCompletion(
  completion: ChatCompletion,
  tools: DialectTool[],
  ask: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): ChatCompletion {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  if (!choice || !message || message.tool_calls?.length) return completion;
  if (typeof message.content !== "string" || tools.length === 0) {
    return completion;
  }
  const found = recoverFromText(
    completion.model,
    message.content,
    tools,
    ask,
    env,
  );
  if (found.calls.length === 0) return completion;
  message.content = found.text || null;
  message.tool_calls = found.calls.map((call, i) => ({
    id: recoveredCallId(i),
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  choice.finish_reason = "tool_calls";
  return completion;
}
