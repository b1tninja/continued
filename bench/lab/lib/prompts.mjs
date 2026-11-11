// System prompts that ask for tool calls in a family's own trained-in form,
// for use when the request carries no `tools` field. One renderer per
// promptStyle of the preset table. Each states the tool definitions and one
// example call in the style, which is what the family's chat template does.
// `codeblock` mirrors the product's generic framework (core/tools/
// systemMessageTools/toolCodeblocks) as written on 2026-11-10.

const props = (t) => Object.entries(t.parameters?.properties ?? {});
const req = (t, k) => (t.parameters?.required ?? []).includes(k);
const example = (tools) =>
  tools[0] ?? {
    name: "example_tool",
    parameters: { properties: { arg: { type: "string" } } },
  };
const exArgs = (t) => {
  const e = {};
  for (const [k, v] of props(t)) {
    if (!req(t, k) && Object.keys(e).length) continue;
    e[k] =
      v.type === "integer" || v.type === "number"
        ? 1
        : v.type === "boolean"
          ? true
          : v.type === "array"
            ? ["a"]
            : v.type === "object"
              ? {}
              : "value";
  }
  return e;
};

const FOOT =
  "Call a tool only when the request needs one. If no tool is needed, answer in plain text and write no tool markup.";

const RENDER = {
  "qwen-xml"(tools) {
    const ex = example(tools);
    const defs = tools
      .map(
        (t) =>
          `<function>\n<name>${t.name}</name>\n<description>${t.description ?? ""}</description>\n<parameters>\n` +
          props(t)
            .map(
              ([k, v]) =>
                `<parameter>\n<name>${k}</name>\n<type>${v.type ?? "string"}</type>\n<description>${v.description ?? ""}</description>\n</parameter>`,
            )
            .join("\n") +
          `\n</parameters>\n</function>`,
      )
      .join("\n");
    const params = Object.entries(exArgs(ex))
      .map(
        ([k, v]) =>
          `<parameter=${k}>\n${typeof v === "string" ? v : JSON.stringify(v)}\n</parameter>`,
      )
      .join("\n");
    return `You have access to the following functions:\n\n<tools>\n${defs}\n</tools>\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=${ex.name}>\n${params}\n</function>\n</tool_call>\n\nYou may issue several <tool_call> blocks for independent calls. ${FOOT}`;
  },
  "hermes-json"(tools) {
    const ex = example(tools);
    const defs = tools
      .map((t) =>
        JSON.stringify({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }),
      )
      .join("\n");
    return `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags.\n\n<tools>\n${defs}\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n${JSON.stringify({ name: ex.name, arguments: exArgs(ex) })}\n</tool_call>\n\n${FOOT}`;
  },
  "glm-xml"(tools) {
    const ex = example(tools);
    const defs = tools
      .map((t) =>
        JSON.stringify({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }),
      )
      .join("\n");
    const args = Object.entries(exArgs(ex))
      .map(
        ([k, v]) =>
          `<arg_key>${k}</arg_key>\n<arg_value>${typeof v === "string" ? v : JSON.stringify(v)}</arg_value>`,
      )
      .join("\n");
    return `You may call one or more functions to assist with the user query.\n\n<tools>\n${defs}\n</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n<tool_call>${ex.name}\n${args}\n</tool_call>\n\n${FOOT}`;
  },
  pythonic(tools) {
    const ex = example(tools);
    const defs = tools
      .map((t) =>
        JSON.stringify({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }),
      )
      .join("\n");
    const call = `${ex.name}(${Object.entries(exArgs(ex))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ")})`;
    return `You can call functions. Here are their definitions:\n${defs}\n\nWhen you call functions, reply with a python list of calls and nothing else, for example: [${call}]\n${FOOT}`;
  },
  "llama-json"(tools) {
    const ex = example(tools);
    const defs = tools
      .map((t) =>
        JSON.stringify(
          {
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          },
          null,
          2,
        ),
      )
      .join("\n\n");
    return `Given the following functions, respond with a JSON for a function call with its proper arguments that best answers the given prompt.\n\nRespond in the format {"name": function name, "parameters": dictionary of argument name and its value}. Do not use variables.\n\n${defs}\n\nExample: ${JSON.stringify({ name: ex.name, parameters: exArgs(ex) })}\n${FOOT}`;
  },
  "toolcall-json"(tools) {
    const ex = example(tools);
    const defs = tools
      .map((t) =>
        JSON.stringify({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }),
      )
      .join("\n");
    return `You can use the following tools:\n<AVAILABLE_TOOLS>[${defs.split("\n").join(", ")}]</AVAILABLE_TOOLS>\n\nIf you decide to call tools, reply with a list of calls inside <TOOLCALL></TOOLCALL>:\n<TOOLCALL>[${JSON.stringify({ name: ex.name, arguments: exArgs(ex) })}]</TOOLCALL>\n${FOOT}`;
  },
  codeblock(tools) {
    const defs = tools
      .map(
        (t) =>
          "```tool_definition\nTOOL_NAME: " +
          t.name +
          "\n" +
          (t.description ? `TOOL_DESCRIPTION:\n${t.description}\n` : "") +
          props(t)
            .map(
              ([k, v]) =>
                `TOOL_ARG: ${k} (${v.type ?? "string"}, ${req(t, k) ? "required" : "optional"})\n${v.description ?? ""}\nEND_ARG\n`,
            )
            .join("") +
          "```",
      )
      .join("\n\n");
    const ex = example(tools);
    const exCall =
      "```tool\nTOOL_NAME: " +
      ex.name +
      "\n" +
      Object.entries(exArgs(ex))
        .map(([k, v]) => `BEGIN_ARG: ${k}\n${JSON.stringify(v)}\nEND_ARG`)
        .join("\n") +
      "\n```";
    return `You have access to tools. To call a tool, you MUST respond with EXACTLY the tool code block format shown below.\n\nCRITICAL: Follow the exact syntax. Do not use XML tags, JSON objects, or any other format for tool calls.\n\n${defs}\n\nExample call:\n${exCall}\n\nRULES: output one tool code block, make it the last thing in the reply, and stop after the closing fence. Do not invent tools. ${FOOT}`;
  },
};

export const TEXT_STYLES = Object.keys(RENDER);

/** The system text that teaches `style` for `tools`; throws for an unknown style. */
export function renderToolsPrompt(style, tools) {
  const f = RENDER[style];
  if (!f) throw new Error(`no renderer for prompt style ${style}`);
  return f(tools);
}

/** The text style a model is asked in: its preset's, else the generic codeblock. */
export function styleFor(preset) {
  const s = preset?.promptStyle?.style;
  return s && RENDER[s] ? s : "codeblock";
}

/** Fill {{TOOL_NAMES}}, {{TOOL_LIST}} and {{TOOLS_JSON}} in a variant template. */
export function fillTemplate(template, tools) {
  return template
    .replaceAll("{{TOOL_NAMES}}", tools.map((t) => t.name).join(", "))
    .replaceAll(
      "{{TOOL_LIST}}",
      tools.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n"),
    )
    .replaceAll(
      "{{TOOLS_JSON}}",
      JSON.stringify(
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        null,
        1,
      ),
    );
}
