import { act, screen } from "@testing-library/react";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { ModeModelsTable } from "./ModeModelsTable";

const model = (title: string) =>
  ({ title, model: title, provider: "openai" }) as any;
export const ALL_MODELS = ["Alpha", "Bravo", "Charlie"].map(model);

/** A prompt block from `prompts:` in config.yaml, as the GUI receives it. */
export const promptBlock = (name: string) =>
  ({
    name,
    description: "",
    prompt: "...",
    source: "yaml-prompt-block",
  }) as any;

/**
 * Render the table with a config, recording every `config/setModeModels`
 * call. `extra` is merged into the config (for example `slashCommands`).
 */
export async function setupTable(
  modeModels?: any,
  response: { saved: boolean } | "fail" = { saved: true },
  extra: Record<string, any> = {},
) {
  const ideMessenger = new MockIdeMessenger();
  const calls: any[] = [];
  ideMessenger.responseHandlers["config/setModeModels"] = async (data) => {
    calls.push(data);
    if (response === "fail") throw new Error("boom");
    return response;
  };
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<ModeModelsTable />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: ALL_MODELS },
        ...(modeModels ? { modeModels } : {}),
        ...extra,
      }),
    );
  });
  return { ...view, store, calls };
}

export const box = (mode: string, title: string) =>
  screen.getByLabelText(`${mode}: ${title}`) as HTMLInputElement;
export const star = (mode: string, title: string) =>
  screen.getByLabelText(`Default for ${mode}: ${title}`);
export const saveButton = () =>
  screen.getByTestId("mode-models-save") as HTMLButtonElement;
export const promptSelect = (mode: string) =>
  screen.getByLabelText(`Prompt for ${mode}`) as HTMLSelectElement;
export const tailSelect = (mode: string) =>
  screen.getByLabelText(`Reminder for ${mode}`) as HTMLSelectElement;
export const tailText = (mode: string) =>
  screen.getByLabelText(`Reminder text for ${mode}`) as HTMLInputElement;
