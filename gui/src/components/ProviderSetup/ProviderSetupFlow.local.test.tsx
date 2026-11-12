import { screen, waitFor } from "@testing-library/react";
import type { ProviderSetupInfo } from "core/config/providerSetup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCatalogueAnswers } from "../../pages/AddNewModel/configs/fetchProviderModels";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { ProviderSetupFlow } from "./ProviderSetupFlow";

const EMPTY_SETUP: ProviderSetupInfo = {
  connections: [],
  secureStorageAvailable: true,
  preferredKeyStorage: "secure",
  editable: true,
};

const STRATA_MODEL = {
  name: "qwen3.8-flash-next-nvfp4-nvfp4",
  modelId: "qwen3.8-flash-next-nvfp4-nvfp4",
  contextLength: 524288,
  supportsTools: true,
  supportsImages: true,
};

function messengerWith(setup: ProviderSetupInfo = EMPTY_SETUP) {
  const messenger = new MockIdeMessenger();
  const saves: any[] = [];
  const fetches: any[] = [];
  messenger.responseHandlers["config/getProviderSetup"] = async () => setup;
  messenger.responseHandlers["config/saveProviderModels"] = async (req) => {
    saves.push(req);
    return { saved: true };
  };
  messenger.responseHandlers["models/fetch"] = async (req) => {
    fetches.push(req);
    return [STRATA_MODEL];
  };
  messenger.responseHandlers["models/detectLocal"] = async () => [
    {
      title: "Strata",
      apiBase: "http://127.0.0.1:8083/v1/",
      models: [STRATA_MODEL],
    },
  ];
  return { messenger, saves, fetches };
}

async function checkModel(name: string) {
  const box = (await screen.findByLabelText(name)) as HTMLInputElement;
  if (!box.checked) box.click();
  await waitFor(() => expect(box.checked).toBe(true));
}

describe("ProviderSetupFlow: local server", () => {
  it("detects Strata, lists its model with its context window, and saves it", async () => {
    const { messenger, saves } = messengerWith();
    const onDone = vi.fn();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openai-compatible" onDone={onDone} />,
      { mockIdeMessenger: messenger },
    );

    await user.click(screen.getByRole("button", { name: "Detect" }));
    const found = await screen.findByRole("list", { name: "Found servers" });
    expect(found.textContent).toContain("Strata");
    expect(found.textContent).toContain("http://127.0.0.1:8083/v1/");
    // The only server with a model is used straight away.
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    await waitFor(() =>
      expect(address.value).toBe("http://127.0.0.1:8083/v1/"),
    );

    // No key is needed.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await checkModel(STRATA_MODEL.name);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(saves).toHaveLength(1);
    expect(saves[0].provider).toBe("openai");
    expect(saves[0].connection).toEqual({
      apiBase: "http://127.0.0.1:8083/v1/",
    });
    expect(saves[0].key).toBeUndefined();
    // A new connection becomes a provider account, named after the server
    expect(saves[0].account).toEqual({ name: "Strata" });
    const added = saves[0].add.find(
      (m: any) => m.model === STRATA_MODEL.modelId,
    );
    expect(added).toMatchObject({
      provider: "openai",
      apiBase: "http://127.0.0.1:8083/v1/",
      contextLength: 524288,
      // From /props: agent mode and images work without editing the config
      capabilities: { tools: true, uploadImage: true },
    });
  });

  it("selects the server's own models, not the provider's presets", async () => {
    const { messenger, saves } = messengerWith();
    const onDone = vi.fn();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openai-compatible" onDone={onDone} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    const box = (await screen.findByLabelText(
      STRATA_MODEL.name,
    )) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    expect(screen.getByTestId("model-checklist").textContent).toContain(
      "1 model selected",
    );
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(saves[0].add.map((m: any) => m.model)).toEqual([
      STRATA_MODEL.modelId,
    ]);
  });

  it("names the account after a server that says what it is, without Detect", async () => {
    const { messenger, saves } = messengerWith();
    messenger.responseHandlers["models/fetch"] = async () => [
      { ...STRATA_MODEL, server: "Strata" },
    ];
    const onDone = vi.fn();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openai-compatible" onDone={onDone} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await checkModel(STRATA_MODEL.name);
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect((await screen.findByTestId("review-account")).textContent).toContain(
      'the account "Strata"',
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(saves[0].account).toEqual({ name: "Strata" });
  });

  it("lists the models at the default address (port 8080) on Next", async () => {
    const { messenger, fetches } = messengerWith();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai-compatible"
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    expect(address.value).toBe("http://127.0.0.1:8080/v1/");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText(STRATA_MODEL.name);
    expect(fetches.find((f) => f.provider === "openai")).toMatchObject({
      apiBase: "http://127.0.0.1:8080/v1/",
    });
  });

  it("chooses a usual address with one click", async () => {
    const { messenger } = messengerWith();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai-compatible"
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "LM Studio (1234)" }));
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    await waitFor(() =>
      expect(address.value).toBe("http://127.0.0.1:1234/v1/"),
    );
  });

  it("keeps a local server's key apart from the OpenAI key", async () => {
    const { messenger, saves } = messengerWith();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai-compatible"
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    await user.type(screen.getByLabelText("API key"), "local-secret");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await checkModel(STRATA_MODEL.name);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].key).toMatchObject({
      secretName: "CONTINUOUS_LOCAL_API_KEY",
      value: "local-secret",
    });
  });

  it("opens a configured openai connection to another server as a local server", async () => {
    const { messenger } = messengerWith({
      ...EMPTY_SETUP,
      connections: [
        {
          provider: "openai",
          connection: { apiBase: "http://127.0.0.1:8083/v1" },
          models: [{ name: "Strata", model: STRATA_MODEL.modelId }],
          key: { state: "none" },
        },
      ],
    });
    await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai"
        initialConnection={{ apiBase: "http://127.0.0.1:8083/v1" }}
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    expect(
      screen.getByRole("heading", {
        name: "Edit Local server (OpenAI-compatible)",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("local-server-picker")).toBeTruthy();
  });
});

describe("ProviderSetupFlow: catalogue fetch only on request", () => {
  beforeEach(() => resetCatalogueAnswers());

  function setup(fail = false) {
    const { messenger, fetches } = messengerWith();
    messenger.responseHandlers["models/fetch"] = async (req) => {
      fetches.push(req);
      if (fail) throw new Error("offline");
      return [
        {
          name: "zz-test/new-model",
          modelId: "zz-test/new-model",
          contextLength: 8192,
        },
      ];
    };
    return { messenger, fetches };
  }

  const idle = () => new Promise((r) => setTimeout(r, 50));

  it("sends no models/fetch on mount", async () => {
    const { messenger, fetches } = setup();
    await renderWithProviders(<ProviderSetupFlow onDone={vi.fn()} />, {
      mockIdeMessenger: messenger,
    });
    await idle();
    expect(fetches).toHaveLength(0);
  });

  for (const [id, host] of [
    ["ollama", "ollama.com"],
    ["openrouter", "openrouter.ai"],
  ] as const) {
    it(`${id}: prompt sends nothing; Download one request; Refresh one per click`, async () => {
      const { messenger, fetches } = setup();
      const { user } = await renderWithProviders(
        <ProviderSetupFlow initialProvider={id} onDone={vi.fn()} />,
        { mockIdeMessenger: messenger },
      );
      await idle();
      expect(screen.getByText(new RegExp(`latest model list from ${host}`)));
      expect(fetches).toHaveLength(0);
      await user.click(screen.getByRole("button", { name: "Download" }));
      await waitFor(() => expect(fetches).toHaveLength(1));
      expect(fetches[0].provider).toBe(id);
      expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
      if (id === "openrouter") {
        await user.type(screen.getByLabelText(/API key/i), "test-key");
      }
      await user.click(screen.getByRole("button", { name: "Next" }));
      const btn = await screen.findByRole("button", {
        name: `Refresh from ${host}`,
      });
      await user.click(btn);
      await waitFor(() => expect(fetches).toHaveLength(2));
      await user.click(btn);
      await waitFor(() => expect(fetches).toHaveLength(3));
    });
  }

  it("Not now sends nothing and keeps the bundled list", async () => {
    const { messenger, fetches } = setup();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="ollama" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByTestId("model-checklist")).toBeTruthy();
    await idle();
    expect(fetches).toHaveLength(0);
  });

  it("OpenRouter without a download says the list is not downloaded", async () => {
    const { messenger } = setup();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await user.type(screen.getByLabelText(/API key/i), "test-key");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Model list not downloaded/)).toBeTruthy();
  });

  it("keeps the bundled list and says so when offline", async () => {
    const { messenger, fetches } = setup(true);
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="ollama" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Could not reach ollama.com/)).toBeTruthy();
    expect(fetches).toHaveLength(1);
    expect(screen.getByTestId("model-checklist")).toBeTruthy();
  });
});
