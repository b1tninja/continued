import { resolveModeModels } from "./modeModels";

const chat = [{ title: "Opus" }, { title: "Sonnet" }, { title: "Haiku" }];

describe("resolveModeModels", () => {
  it("returns undefined when not configured", () => {
    expect(resolveModeModels(undefined, chat)).toEqual({
      modeModels: undefined,
      errors: [],
    });
  });

  it("maps model names to titles and keeps reasoning effort", () => {
    const { modeModels, errors } = resolveModeModels(
      {
        plan: { model: "Opus", reasoningEffort: "medium" },
        agent: { model: "Sonnet", reasoningEffort: "low" },
        chat: { model: "Haiku" },
      },
      chat,
    );
    expect(errors).toEqual([]);
    expect(modeModels).toEqual({
      plan: { title: "Opus", reasoningEffort: "medium" },
      agent: { title: "Sonnet", reasoningEffort: "low" },
      chat: { title: "Haiku" },
    });
  });

  it("drops unknown models with a non-fatal error listing the options", () => {
    const { modeModels, errors } = resolveModeModels(
      { plan: { model: "Opus 9" }, agent: { model: "Sonnet" } },
      chat,
    );
    expect(modeModels).toEqual({ agent: { title: "Sonnet" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(false);
    expect(errors[0].message).toContain(
      'modeModels.plan: no chat model named "Opus 9"',
    );
    expect(errors[0].message).toContain("Opus, Sonnet, Haiku");
  });

  describe("models: list", () => {
    it("leaves titles unset when only `model` is given (unchanged behaviour)", () => {
      const { modeModels } = resolveModeModels(
        { plan: { model: "Opus" } },
        chat,
      );
      expect(modeModels?.plan).toEqual({ title: "Opus" });
    });

    it("puts the default first and keeps the rest in order", () => {
      const { modeModels, errors } = resolveModeModels(
        { plan: { model: "Sonnet", models: ["Opus", "Sonnet", "Haiku"] } },
        chat,
      );
      expect(errors).toEqual([]);
      expect(modeModels?.plan).toEqual({
        title: "Sonnet",
        titles: ["Sonnet", "Opus", "Haiku"],
      });
    });

    it("defaults to the first listed model when `model` is not set", () => {
      const { modeModels } = resolveModeModels(
        { agent: { models: ["Haiku", "Opus"] } },
        chat,
      );
      expect(modeModels?.agent).toEqual({
        title: "Haiku",
        titles: ["Haiku", "Opus"],
      });
    });

    it("always offers the default even when it is not in the list", () => {
      const { modeModels } = resolveModeModels(
        { plan: { model: "Opus", models: ["Sonnet"] } },
        chat,
      );
      expect(modeModels?.plan?.titles).toEqual(["Opus", "Sonnet"]);
    });

    it("removes duplicates", () => {
      const { modeModels } = resolveModeModels(
        { plan: { models: ["Opus", "Opus", "Sonnet", "Opus"] } },
        chat,
      );
      expect(modeModels?.plan?.titles).toEqual(["Opus", "Sonnet"]);
    });

    it("drops unknown names with an error that names the list, keeps the rest", () => {
      const { modeModels, errors } = resolveModeModels(
        { plan: { models: ["Opus", "Nope", "Sonnet"] } },
        chat,
      );
      expect(modeModels?.plan?.titles).toEqual(["Opus", "Sonnet"]);
      expect(errors).toHaveLength(1);
      expect(errors[0].fatal).toBe(false);
      expect(errors[0].message).toContain(
        'modeModels.plan.models: no chat model named "Nope"',
      );
    });

    it("falls back to the first valid listed model if the default is unknown", () => {
      const { modeModels, errors } = resolveModeModels(
        { plan: { model: "Nope", models: ["Sonnet", "Opus"] } },
        chat,
      );
      expect(modeModels?.plan).toEqual({
        title: "Sonnet",
        titles: ["Sonnet", "Opus"],
      });
      expect(errors.map((e) => e.message)).toEqual([
        expect.stringContaining('modeModels.plan: no chat model named "Nope"'),
      ]);
    });

    it("drops the entry when nothing in it exists", () => {
      const { modeModels, errors } = resolveModeModels(
        { plan: { model: "Nope", models: ["Also nope"] } },
        chat,
      );
      expect(modeModels).toBeUndefined();
      expect(errors).toHaveLength(2);
    });

    it("keeps reasoning effort and handles each mode on its own", () => {
      const { modeModels } = resolveModeModels(
        {
          plan: { models: ["Opus", "Sonnet"], reasoningEffort: "high" },
          chat: { model: "Haiku" },
        },
        chat,
      );
      expect(modeModels?.plan?.reasoningEffort).toBe("high");
      expect(modeModels?.chat).toEqual({ title: "Haiku" });
    });
  });
});

describe("uses beyond the modes", () => {
  const all = [...chat, { title: "Judge" }];

  it("resolves loop, replan and subagent against the chat models", () => {
    const { modeModels, errors } = resolveModeModels(
      {
        loop: { model: "Haiku", reasoningEffort: "off" },
        replan: { model: "Opus" },
        subagent: { model: "Sonnet" },
      },
      chat,
      all,
    );
    expect(errors).toEqual([]);
    expect(modeModels).toEqual({
      loop: { title: "Haiku", reasoningEffort: "off" },
      replan: { title: "Opus" },
      subagent: { title: "Sonnet" },
    });
  });

  it("lets the reviewer be any model, not only a chat model", () => {
    const { modeModels, errors } = resolveModeModels(
      { reviewer: { model: "Judge" }, subagent: { model: "Judge" } },
      chat,
      all,
    );
    expect(modeModels).toEqual({ reviewer: { title: "Judge" } });
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining(
        'modeModels.subagent: no chat model named "Judge"',
      ),
    ]);
  });

  it("reports an unknown reviewer against every model", () => {
    const { modeModels, errors } = resolveModeModels(
      { reviewer: { model: "Nope" } },
      chat,
      all,
    );
    expect(modeModels).toBeUndefined();
    expect(errors[0].message).toContain(
      'modeModels.reviewer: no model named "Nope"',
    );
    expect(errors[0].message).toContain("Judge");
  });

  it("does not fill in fallbacks: a missing loop entry stays missing", () => {
    const { modeModels } = resolveModeModels(
      { agent: { model: "Sonnet" } },
      chat,
    );
    expect(modeModels).toEqual({ agent: { title: "Sonnet" } });
  });
});

describe("prompt per use", () => {
  const prompts = [{ name: "house", prompt: "Be brief." }];

  it("keeps a profile name and copies a block's text in", () => {
    const { modeModels, errors } = resolveModeModels(
      {
        agent: { model: "Sonnet", prompt: "short" },
        plan: { model: "Opus", prompt: "house" },
      },
      chat,
      chat,
      prompts,
    );
    expect(errors).toEqual([]);
    expect(modeModels).toEqual({
      agent: { title: "Sonnet", prompt: "short" },
      plan: { title: "Opus", prompt: "house", promptText: "Be brief." },
    });
  });

  it("keeps the tail as written, a boolean as on or off, and an entry with only a tail", () => {
    const { modeModels, errors } = resolveModeModels(
      {
        agent: { model: "Sonnet", tail: "on" },
        loop: { tail: false },
        replan: { model: "Opus", tail: "Plan, then present it." },
        reviewer: { model: "Haiku", tail: "on" } as any,
      },
      chat,
    );
    expect(errors).toEqual([]);
    expect(modeModels).toEqual({
      agent: { title: "Sonnet", tail: "on" },
      loop: { tail: "off" },
      replan: { title: "Opus", tail: "Plan, then present it." },
      reviewer: { title: "Haiku" },
    });
  });

  it("an entry may choose only a prompt", () => {
    const { modeModels } = resolveModeModels(
      { loop: { prompt: "short" } },
      chat,
      chat,
      prompts,
    );
    expect(modeModels).toEqual({ loop: { prompt: "short" } });
  });

  it("drops an unknown prompt name with an error that lists the blocks, and keeps the model", () => {
    const { modeModels, errors } = resolveModeModels(
      { agent: { model: "Sonnet", prompt: "nope" } },
      chat,
      chat,
      prompts,
    );
    expect(modeModels).toEqual({ agent: { title: "Sonnet" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('modeModels.agent.prompt: "nope"');
    expect(errors[0].message).toContain("house");
  });

  it("ignores a prompt on the reviewer and subagent entries", () => {
    const { modeModels, errors } = resolveModeModels(
      { reviewer: { model: "Opus", prompt: "short" } as any },
      chat,
      chat,
      prompts,
    );
    expect(errors).toEqual([]);
    expect(modeModels).toEqual({ reviewer: { title: "Opus" } });
  });
});
