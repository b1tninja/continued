import type { ToolDialectSetting } from "@continuedev/config-yaml";
import type { ModelDescription } from "core";
import { defaultSecretName } from "core/config/providerSecretName";
import type {
  DiffLine,
  ModelBlockInfo,
} from "core/config/modelEdit/modelBlockEdit";
import {
  MODEL_EDIT_FIELDS,
  MODEL_ROLES,
  DEFAULT_ROLES,
  pathKey,
  type ModelEditField,
  type ModelEditSection,
  type ModelPatchOp,
  type TriState,
} from "core/config/modelEdit/modelEditFields";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { formatPriceSource } from "core/llm/utils/priceSourceText";
import { hasConnectionTest } from "core/util/anthropicSurfaceTest";
import { costOf } from "core/util/costOf";
import { providerRecoversText } from "core/util/toolDialectLeak";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { BedrockConnectionTester } from "../../forms/BedrockConnectionTester";
import { FormSelect } from "../../forms/FormSelect";
import { OpenAICompatConnectionTester } from "../../forms/OpenAICompatConnectionTester";
import { useAppSelector } from "../../redux/hooks";
import { Button } from "../ui";
import {
  fieldError,
  formFromBlock,
  formToOps,
  headerIsSensitive,
  visibleFields,
  type BoolChoice,
  type HeaderRow,
  type KeyChoice,
  type ModelForm,
} from "./modelConfigForm";
import {
  DIALECT_INFO,
  presetHint,
  SAMPLE_TOOL_NAME,
  toolPromptPreview,
} from "./toolPreview";

type Tab = ModelEditSection;

const TABS: { id: Tab; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "capabilities", label: "Capabilities" },
  { id: "generation", label: "Generation" },
  { id: "context", label: "Context & cost" },
];

const inputClass =
  "w-full rounded-default border border-solid border-input-border bg-input px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-border-focus aria-[invalid=true]:border-error";

/** Which tab shows the field at this path (for jumping to an error). */
function tabOf(key: string): Tab {
  if (key === "capabilities") return "capabilities";
  if (key === "apiKey" || key.startsWith("requestOptions.headers")) {
    return "connection";
  }
  const f = MODEL_EDIT_FIELDS.find((x) => pathKey(x.path) === key);
  return f?.section ?? "connection";
}

function findLoadedModel(
  byRole: Record<string, ModelDescription[] | undefined> | undefined,
  title: string,
): ModelDescription | undefined {
  for (const models of Object.values(byRole ?? {})) {
    const hit = models?.find((m) => m.title === title);
    if (hit) return hit;
  }
  return undefined;
}

interface Props {
  /** The model's name in config.yaml (its title in the GUI). */
  title: string;
  onDone: () => void;
  onCancel: () => void;
  /** Open the file the model is defined in. */
  onOpenFile: () => void;
}

/**
 * "Configure..." for one model: view and change the settings config.yaml
 * already has for it, review the YAML change, and save it with comments and
 * every other key kept. Credentials are only ever written as secret
 * references.
 */
export function ModelConfigDialog({
  title,
  onDone,
  onCancel,
  onOpenFile,
}: Props) {
  const ideMessenger = useContext(IdeMessengerContext);
  const titleId = useId();
  const config = useAppSelector((s) => s.config.config);
  const loaded = findLoadedModel(
    config.modelsByRole as Record<string, ModelDescription[]>,
    title,
  );

  const [info, setInfo] = useState<ModelBlockInfo>();
  const [loadError, setLoadError] = useState<string>();
  const [initial, setInitial] = useState<ModelForm>();
  const [form, setForm] = useState<ModelForm>();
  const [tab, setTab] = useState<Tab>("connection");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{
    ops: ModelPatchOp[];
    diff: DiffLine[];
    baseHash: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    let live = true;
    void ideMessenger.request("config/getModelBlock", { title }).then((res) => {
      if (!live) return;
      if (res.status !== "success") {
        setLoadError(String(res.error ?? "Could not read the config."));
        return;
      }
      setInfo(res.content);
      if (res.content.editable) {
        const f = formFromBlock(res.content);
        setInitial(f);
        setForm(f);
      }
    });
    return () => {
      live = false;
    };
  }, [ideMessenger, title]);

  const ready = form !== undefined;
  useEffect(() => {
    if (ready) tabRefs.current.connection?.focus();
  }, [ready]);

  const provider = String(form?.fields.provider || loaded?.provider || "");
  const modelId = String(form?.fields.model || loaded?.model || "");

  function update(key: string, value: string | string[] | null) {
    setForm((f) => f && { ...f, fields: { ...f.fields, [key]: value } });
    setErrors(({ [key]: _gone, ...rest }) => rest);
    setReview(undefined);
  }
  function patchForm(p: Partial<ModelForm>) {
    setForm((f) => f && { ...f, ...p });
    setReview(undefined);
  }

  async function startReview() {
    if (!form || !initial) return;
    setNotice(undefined);
    const { ops, errors: errs } = formToOps(initial, form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      setTab(tabOf(Object.keys(errs)[0]));
      return;
    }
    const storesKey = form.key.mode === "secret" && form.key.value !== "";
    if (ops.length === 0 && !storesKey) {
      setNotice("Nothing has changed.");
      return;
    }
    setBusy(true);
    try {
      const res = await ideMessenger.request("config/previewModelEdit", {
        title,
        ops,
      });
      if (res.status !== "success") {
        setNotice(String(res.error ?? "Could not check the change."));
        return;
      }
      const p = res.content;
      if (p.errors.length > 0) {
        const byPath = Object.fromEntries(
          p.errors.map((e) => [e.path.join("."), e.message]),
        );
        setErrors(byPath);
        setTab(tabOf(Object.keys(byPath)[0]));
        return;
      }
      if (p.error) {
        setNotice(p.error);
        return;
      }
      setReview({ ops, diff: p.diff, baseHash: p.baseHash ?? "" });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!review || !form) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const key = form.key;
      if (key.mode === "secret" && key.value !== "") {
        const stored = await ideMessenger.request("config/setSecret", {
          secretName: key.secretName,
          value: key.value,
          storage: key.storage,
        });
        if (stored.status !== "success" || !stored.content.stored) {
          setNotice(
            stored.status === "success"
              ? (stored.content.error ?? "The key could not be stored.")
              : String(stored.error ?? "The key could not be stored."),
          );
          return;
        }
      }
      if (review.ops.length === 0) return onDone();
      const res = await ideMessenger.request("config/saveModelEdit", {
        title,
        ops: review.ops,
        baseHash: review.baseHash,
      });
      if (res.status !== "success") {
        setNotice(String(res.error ?? "Could not save."));
        return;
      }
      if (res.content.stale) {
        setReview(undefined);
        setNotice(res.content.error);
        return;
      }
      if (res.content.errors.length > 0 || res.content.error) {
        setReview(undefined);
        setNotice(
          res.content.error ??
            res.content.errors.map((e) => e.message).join(" "),
        );
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  function onTabKey(e: React.KeyboardEvent, index: number) {
    const last = TABS.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  }

  const errorTabs = useMemo(
    () => new Set(Object.keys(errors).map(tabOf)),
    [errors],
  );

  const header = (
    <div className="flex flex-col gap-1">
      <h2 id={titleId} className="m-0 text-base">
        Configure {title}
      </h2>
      {info?.file && (
        <span className="text-2xs break-all text-description-muted">
          {info.scope === "workspace" ? "Workspace config" : "User config"}:{" "}
          <code>{info.file}</code>{" "}
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent p-0 text-2xs text-link underline"
            onClick={onOpenFile}
          >
            Open file
          </button>
        </span>
      )}
    </div>
  );

  if (loadError || (info && !info.editable)) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex flex-col gap-3 p-4"
        data-testid="model-config-dialog"
      >
        {header}
        <p className="m-0 text-sm" role="alert">
          {loadError ?? info?.reason}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Close
          </Button>
          <Button onClick={onOpenFile}>Open file</Button>
        </div>
      </div>
    );
  }

  if (!form || !info) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy="true"
        className="p-4 text-sm"
        data-testid="model-config-dialog"
      >
        {header}
        <p>Loading...</p>
      </div>
    );
  }

  const fieldProps = { form, errors, update, provider, entry: info.entry };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="flex flex-col gap-3 p-4"
      data-testid="model-config-dialog"
    >
      {header}

      {review ? (
        <ReviewPanel
          diff={review.diff}
          storesKey={
            form.key.mode === "secret" && form.key.value !== ""
              ? { name: form.key.secretName, storage: form.key.storage }
              : undefined
          }
        />
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Model settings"
            className="flex flex-wrap gap-1 border-0 border-b border-solid border-border"
          >
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                id={`${titleId}-tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-controls={`${titleId}-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={`cursor-pointer border-0 border-b-2 border-solid bg-transparent px-2 py-1 text-xs text-foreground ${
                  tab === t.id
                    ? "border-b-border-focus"
                    : "border-b-transparent"
                }`}
              >
                {t.label}
                {errorTabs.has(t.id) && (
                  <span className="ml-1 text-error">
                    <span aria-hidden="true">!</span>
                    <span className="sr-only"> (has errors)</span>
                  </span>
                )}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`${titleId}-panel-${tab}`}
            aria-labelledby={`${titleId}-tab-${tab}`}
            className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1"
          >
            {tab === "connection" && (
              <ConnectionPanel
                {...fieldProps}
                info={info}
                loaded={loaded}
                title={title}
                modelId={modelId}
                setKey={(key) => {
                  patchForm({ key });
                  setErrors(({ apiKey: _gone, ...rest }) => rest);
                }}
                setHeaders={(headers) => patchForm({ headers })}
              />
            )}
            {tab === "capabilities" && (
              <CapabilitiesPanel
                {...fieldProps}
                loaded={loaded}
                modelId={modelId}
                systemToolsForced={
                  !!config.experimental?.onlyUseSystemMessageTools
                }
                setTri={(p) => {
                  patchForm(p);
                  setErrors(({ capabilities: _gone, ...rest }) => rest);
                }}
              />
            )}
            {tab === "generation" && (
              <FieldList section="generation" {...fieldProps} />
            )}
            {tab === "context" && (
              <>
                <FieldList section="context" {...fieldProps} />
                <PriceNote provider={provider} model={modelId} />
              </>
            )}
          </div>
        </>
      )}

      {notice && (
        <p className="m-0 text-xs text-warning" role="status">
          {notice}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {review ? (
          <>
            <Button
              variant="secondary"
              onClick={() => setReview(undefined)}
              disabled={busy}
            >
              Back
            </Button>
            <Button
              onClick={save}
              disabled={busy}
              data-testid="model-config-save"
            >
              Save
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={startReview}
              disabled={busy}
              data-testid="model-config-review"
            >
              Review changes
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

interface FieldProps {
  form: ModelForm;
  errors: Record<string, string>;
  update: (key: string, value: string | string[] | null) => void;
  provider: string;
  entry?: Record<string, unknown>;
}

function FieldList({
  section,
  ...props
}: FieldProps & { section: ModelEditSection }) {
  const fields = visibleFields(section, props.provider, props.entry).filter(
    (f) => pathKey(f.path) !== "roles" && pathKey(f.path) !== "toolDialect",
  );
  return (
    <>
      {fields.map((f) => (
        <FieldInput key={pathKey(f.path)} field={f} {...props} />
      ))}
    </>
  );
}

function FieldInput({
  field,
  form,
  errors,
  update,
}: FieldProps & { field: ModelEditField }) {
  const key = pathKey(field.path);
  const id = `mc-${key.replace(/\./g, "-")}`;
  const value = form.fields[key];
  const error = errors[key] ?? fieldError(field, value);
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const described =
    [error ? errorId : "", field.help ? helpId : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const common = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": described,
  } as const;

  let control: React.ReactNode;
  if (field.kind === "boolean") {
    control = (
      <FormSelect
        {...common}
        className="text-xs"
        value={(value as BoolChoice) ?? "default"}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="default">
          Default{field.defaultText ? ` (${field.defaultText})` : ""}
        </option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </FormSelect>
    );
  } else if (field.kind === "enum") {
    control = (
      <FormSelect
        {...common}
        className="text-xs"
        value={(value as string) ?? ""}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="">
          Default{field.defaultText ? ` (${field.defaultText})` : ""}
        </option>
        {field.options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </FormSelect>
    );
  } else if (field.kind === "list") {
    control = (
      <textarea
        {...common}
        rows={2}
        className={inputClass}
        value={(value as string) ?? ""}
        onChange={(e) => update(key, e.target.value)}
      />
    );
  } else {
    control = (
      <input
        {...common}
        type="text"
        inputMode={field.kind === "number" ? "decimal" : undefined}
        className={inputClass}
        value={(value as string) ?? ""}
        placeholder={
          field.defaultText ? `Default: ${field.defaultText}` : undefined
        }
        onChange={(e) => update(key, e.target.value)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {field.label}
      </label>
      {control}
      {field.help && (
        <span id={helpId} className="text-2xs text-description-muted">
          {field.help}
        </span>
      )}
      {error && (
        <span id={errorId} className="text-2xs text-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function ConnectionPanel(
  props: FieldProps & {
    info: ModelBlockInfo;
    loaded?: ModelDescription;
    title: string;
    modelId: string;
    setKey: (k: KeyChoice) => void;
    setHeaders: (h: HeaderRow[]) => void;
  },
) {
  const { form, info, loaded, provider, modelId, title } = props;
  const connection = info.entry?.connection;
  const apiBase = String(form.fields.apiBase || "") || undefined;
  const typedKey =
    form.key.mode === "secret" && form.key.value ? form.key.value : undefined;
  // The key the loaded model already uses; an unresolved reference is no key.
  const loadedKey =
    loaded?.apiKey && !loaded.apiKey.includes("${{")
      ? loaded.apiKey
      : undefined;
  const isBedrock = provider === "bedrock" || provider === "bedrock-mantle";

  return (
    <>
      {typeof connection === "string" && (
        <p className="m-0 text-xs text-description-muted">
          Connection settings come from the provider account{" "}
          <code>{connection}</code>. A value set here applies to this model only
          and wins over the account's.
        </p>
      )}
      <FieldList section="connection" {...props} />
      <KeyEditor
        state={info.credentials?.apiKey ?? { state: "none" }}
        provider={provider}
        choice={form.key}
        error={props.errors.apiKey}
        onChange={props.setKey}
      />
      <HeadersEditor
        rows={form.headers}
        errors={props.errors}
        onChange={props.setHeaders}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Test connection</span>
        {isBedrock ? (
          <BedrockConnectionTester
            connection={
              Object.fromEntries(
                Object.entries({
                  region: form.fields["env.region"],
                  profile: form.fields["env.profile"],
                  apiBase,
                  ...(provider === "bedrock-mantle"
                    ? { endpoint: "mantle" }
                    : {}),
                }).filter(([, v]) => typeof v === "string" && v !== ""),
              ) as Record<string, string>
            }
            model={modelId}
            canTest={!!modelId}
            onModelsLoaded={() => {}}
          />
        ) : hasConnectionTest(provider) ? (
          <OpenAICompatConnectionTester
            provider={provider}
            apiBase={apiBase}
            apiKey={typedKey ?? loadedKey}
            model={modelId}
            modelTitle={title}
            canTest={!!provider}
          />
        ) : (
          <span className="text-2xs text-description-muted">
            Not available for {provider || "this provider"} yet. Uses the values
            above before they are saved.
          </span>
        )}
      </div>
    </>
  );
}

function KeyEditor({
  state,
  provider,
  choice,
  error,
  onChange,
}: {
  state: NonNullable<ModelBlockInfo["credentials"]>["apiKey"];
  provider: string;
  choice: KeyChoice;
  error?: string;
  onChange: (k: KeyChoice) => void;
}) {
  const groupId = useId();
  const current =
    state.state === "secret"
      ? `Stored as the secret ${state.secretName}.`
      : state.state === "plaintext"
        ? "Written in plain text in config.yaml (hidden here). Move it to a secret so it is not in the file."
        : state.state === "template"
          ? `Read from ${state.text}.`
          : "No key is set.";
  const secretChoice = (): KeyChoice => ({
    mode: "secret",
    secretName:
      state.state === "secret" ? state.secretName : defaultSecretName(provider),
    value: "",
    storage: "secure",
  });
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 text-xs font-medium">API key</legend>
      <span
        className={`text-2xs ${state.state === "plaintext" ? "text-warning" : "text-description-muted"}`}
      >
        {current}
      </span>
      <div
        className="flex flex-wrap gap-3 text-xs"
        role="radiogroup"
        aria-label="API key"
      >
        {(
          [
            ["keep", "Keep as it is"],
            ["secret", "Use a secret"],
            ["remove", "Remove"],
          ] as const
        ).map(([mode, label]) => (
          <label key={mode} className="flex items-center gap-1">
            <input
              type="radio"
              name={`${groupId}-key`}
              checked={choice.mode === mode}
              onChange={() =>
                onChange(mode === "secret" ? secretChoice() : { mode })
              }
            />
            {label}
          </label>
        ))}
      </div>
      {choice.mode === "secret" && (
        <div className="flex flex-col gap-2 pl-4">
          <label className="flex flex-col gap-1 text-xs">
            Secret name
            <input
              className={inputClass}
              value={choice.secretName}
              aria-invalid={error ? true : undefined}
              onChange={(e) =>
                onChange({ ...choice, secretName: e.target.value })
              }
            />
          </label>
          <span className="text-2xs text-description-muted">
            config.yaml gets{" "}
            <code>{`\${{ secrets.${choice.secretName || "NAME"} }}`}</code>,
            never the key.
          </span>
          <label className="flex flex-col gap-1 text-xs">
            New key value (leave empty if this secret is already set)
            <input
              type="password"
              autoComplete="off"
              className={inputClass}
              value={choice.value}
              onChange={(e) => onChange({ ...choice, value: e.target.value })}
            />
          </label>
          {choice.value && (
            <label className="flex flex-col gap-1 text-xs">
              Keep the key in
              <FormSelect
                className="text-xs"
                value={choice.storage}
                onChange={(e) =>
                  onChange({
                    ...choice,
                    storage: e.target.value as "secure" | "env",
                  })
                }
              >
                <option value="secure">Secure storage (this machine)</option>
                <option value="env">~/.continuous/.env (plain text)</option>
              </FormSelect>
            </label>
          )}
        </div>
      )}
      {error && (
        <span className="text-2xs text-error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

function HeadersEditor({
  rows,
  errors,
  onChange,
}: {
  rows: HeaderRow[];
  errors: Record<string, string>;
  onChange: (rows: HeaderRow[]) => void;
}) {
  const set = (id: string, p: Partial<HeaderRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 text-xs font-medium">Request headers</legend>
      {rows.length === 0 && (
        <span className="text-2xs text-description-muted">None.</span>
      )}
      {rows.map((r) => {
        const sensitive = !!r.withheld || headerIsSensitive(r.name);
        const error =
          errors[`requestOptions.headers.${r.name.trim()}`] ??
          errors[`requestOptions.headers.${r.id}`];
        return (
          <div key={r.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <input
                aria-label="Header name"
                className={`${inputClass} w-2/5`}
                value={r.name}
                disabled={!!r.withheld}
                onChange={(e) => set(r.id, { name: e.target.value })}
              />
              <input
                aria-label={`Value of ${r.name || "header"}`}
                aria-invalid={error ? true : undefined}
                className={inputClass}
                value={r.value}
                placeholder={
                  r.withheld
                    ? r.withheld.state === "secret"
                      ? `\${{ secrets.${r.withheld.secretName} }} (kept)`
                      : "hidden (kept unless you type a secret reference)"
                    : sensitive
                      ? "${{ secrets.NAME }}"
                      : undefined
                }
                onChange={(e) => set(r.id, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove header ${r.name}`}
                onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              >
                Remove
              </Button>
            </div>
            {error && (
              <span className="text-2xs text-error" role="alert">
                {error}
              </span>
            )}
          </div>
        );
      })}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...rows,
              { id: `new${Date.now()}${rows.length}`, name: "", value: "" },
            ])
          }
        >
          Add header
        </Button>
      </div>
    </fieldset>
  );
}

const TRI_LABEL: Record<TriState, string> = {
  auto: "Auto-detect",
  on: "Yes",
  off: "No",
};

function CapabilitiesPanel(
  props: FieldProps & {
    loaded?: ModelDescription;
    modelId: string;
    systemToolsForced: boolean;
    setTri: (p: Partial<Pick<ModelForm, "tools" | "images">>) => void;
  },
) {
  const { form, errors, update, loaded, modelId, provider } = props;
  const groupId = useId();
  const roles = form.fields.roles as string[] | null;
  const dialect = (form.fields.toolDialect as string) || "auto";
  const info = DIALECT_INFO[dialect as ToolDialectSetting];
  const detectedNative = loaded
    ? modelSupportsNativeTools({
        ...loaded,
        capabilities: { ...loaded.capabilities, tools: undefined },
      })
    : undefined;
  const effectiveNative = props.systemToolsForced
    ? false
    : form.tools === "auto"
      ? (detectedNative ?? true)
      : form.tools === "on";
  const hint = presetHint(modelId);
  const rolesError = errors.roles;

  return (
    <>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-xs font-medium">Roles</legend>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={roles === null}
            onChange={(e) =>
              update("roles", e.target.checked ? null : [...DEFAULT_ROLES])
            }
          />
          Default ({DEFAULT_ROLES.join(", ")})
        </label>
        {roles !== null && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pl-4 text-xs">
            {MODEL_ROLES.map((r) => (
              <label key={r} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) =>
                    update(
                      "roles",
                      e.target.checked
                        ? [...roles, r]
                        : roles.filter((x) => x !== r),
                    )
                  }
                />
                {r}
              </label>
            ))}
          </div>
        )}
        {(rolesError || (roles && roles.length === 0)) && (
          <span className="text-2xs text-error" role="alert">
            {rolesError ??
              "Pick at least one role, or go back to the default roles."}
          </span>
        )}
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-xs font-medium">
          How tools are sent (prompt style)
        </legend>
        <div
          className="flex flex-wrap gap-3 text-xs"
          role="radiogroup"
          aria-label="How tools are sent"
        >
          {(
            [
              ["auto", "Auto-detect"],
              ["on", "Native tool calls"],
              ["off", "Described in the system message"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-1">
              <input
                type="radio"
                name={`${groupId}-tools`}
                checked={form.tools === v}
                onChange={() => props.setTri({ tools: v })}
              />
              {label}
              {v === "auto" && detectedNative !== undefined && (
                <span className="text-description-muted">
                  ({detectedNative ? "native" : "system message"})
                </span>
              )}
            </label>
          ))}
        </div>
        {props.systemToolsForced && (
          <span className="text-2xs text-warning">
            "Only use system message tools" is on in settings, so every model
            gets its tools in the system message.
          </span>
        )}
        {hint && (
          <span
            className="text-2xs text-description-muted"
            data-testid="preset-hint"
          >
            Known family {hint.label}: asks for {hint.style}. {hint.evidence}
          </span>
        )}
        <Preview
          label={
            effectiveNative
              ? `Sent as an API tool definition (${SAMPLE_TOOL_NAME} shown):`
              : `Added to the system message (${SAMPLE_TOOL_NAME} shown):`
          }
          text={toolPromptPreview(effectiveNative ? "native" : "systemMessage")}
          testId="tool-prompt-preview"
        />
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-xs font-medium">Image input</legend>
        <div
          className="flex flex-wrap gap-3 text-xs"
          role="radiogroup"
          aria-label="Image input"
        >
          {(["auto", "on", "off"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1">
              <input
                type="radio"
                name={`${groupId}-images`}
                checked={form.images === v}
                onChange={() => props.setTri({ images: v })}
              />
              {TRI_LABEL[v]}
            </label>
          ))}
        </div>
      </fieldset>
      {errors.capabilities && (
        <span className="text-2xs text-error" role="alert">
          {errors.capabilities}
        </span>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="mc-toolDialect" className="text-xs font-medium">
          Tool calls written as text (tool dialect)
        </label>
        <FormSelect
          id="mc-toolDialect"
          className="text-xs"
          value={(form.fields.toolDialect as string) ?? ""}
          aria-describedby="mc-toolDialect-summary"
          onChange={(e) => update("toolDialect", e.target.value)}
        >
          <option value="">{DIALECT_INFO.auto.label}</option>
          {Object.entries(DIALECT_INFO)
            .filter(([v]) => v !== "auto")
            .map(([v, d]) => (
              <option key={v} value={v}>
                {d.label} ({v})
              </option>
            ))}
        </FormSelect>
        <span
          id="mc-toolDialect-summary"
          className="text-2xs text-description-muted"
        >
          {info?.summary}
          {hint?.recoverWith && hint.recoverWith !== dialect
            ? ` This family's text calls are read with ${hint.recoverWith}.`
            : ""}
        </span>
        {provider && !providerRecoversText(provider) && dialect !== "auto" && (
          <span className="text-2xs text-warning">
            {provider} requests are not read for text calls in the IDE, so this
            setting has no effect there.
          </span>
        )}
        {info?.sample && (
          <Preview
            label={`A reply in this form runs ${SAMPLE_TOOL_NAME}:`}
            text={info.sample}
            testId="tool-dialect-preview"
          />
        )}
        {errors.toolDialect && (
          <span className="text-2xs text-error" role="alert">
            {errors.toolDialect}
          </span>
        )}
      </div>
    </>
  );
}

function Preview({
  label,
  text,
  testId,
}: {
  label: string;
  text: string;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={id} className="text-2xs text-description-muted">
        {label}
      </span>
      <pre
        aria-labelledby={id}
        tabIndex={0}
        data-testid={testId}
        className="m-0 max-h-40 overflow-auto rounded-default bg-editor p-2 text-2xs whitespace-pre-wrap"
      >
        {text}
      </pre>
    </div>
  );
}

function PriceNote({ provider, model }: { provider: string; model: string }) {
  const ideMessenger = useContext(IdeMessengerContext);
  const per = (input: number, output: number) =>
    costOf({ input, output, cacheRead: 0, cacheWrite: 0 }, { provider, model });
  const inPrice = per(1_000_000, 0);
  const outPrice = per(0, 1_000_000);
  const known = inPrice.amount !== "unknown" && outPrice.amount !== "unknown";
  return (
    <div className="flex flex-col gap-1" data-testid="price-note">
      <span className="text-xs font-medium">Price (used by budgets)</span>
      {known ? (
        <span className="text-2xs">
          ${(inPrice.amount as number).toFixed(2)} in / $
          {(outPrice.amount as number).toFixed(2)} out per million tokens
          {inPrice.priceSource
            ? `. ${formatPriceSource(inPrice.priceSource)}`
            : inPrice.estimate
              ? `, from ${inPrice.estimate.source} as of ${inPrice.estimate.fetchedAt.slice(0, 10)}`
              : ", from the built-in price table"}
          .
          {inPrice.priceSource?.kind === "community" && (
            <>
              {" "}
              A dollar budget (<code>--max-budget-usd</code>) is held on this
              estimate only with <code>--budget-allow-unpriced</code>.
            </>
          )}
        </span>
      ) : (
        <span className="text-2xs text-description-muted">
          No price is known for {provider || "?"}/{model || "?"}, so a dollar
          budget (<code>--max-budget-usd</code>) refuses to run on it and cost
          shows as unknown. There is no price setting in config.yaml yet.
          {provider === "openrouter" && (
            <>
              {" "}
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-2xs text-link underline"
                onClick={() =>
                  ideMessenger.post("openUrl", "https://openrouter.ai/models")
                }
              >
                See OpenRouter's prices
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

function ReviewPanel({
  diff,
  storesKey,
}: {
  diff: DiffLine[];
  storesKey?: { name: string; storage: "secure" | "env" };
}) {
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="model-config-review-panel"
    >
      <h3 className="m-0 text-sm">Review the change to config.yaml</h3>
      {storesKey && (
        <p className="m-0 text-xs">
          The key is stored as <code>{storesKey.name}</code> in{" "}
          {storesKey.storage === "secure"
            ? "secure storage"
            : "~/.continuous/.env"}
          , not in config.yaml.
        </p>
      )}
      {diff.length === 0 ? (
        <p className="m-0 text-xs text-description-muted">
          config.yaml does not change.
        </p>
      ) : (
        <pre
          tabIndex={0}
          aria-label="Changes to config.yaml"
          className="m-0 max-h-[50vh] overflow-auto rounded-default bg-editor p-2 text-2xs"
          data-testid="model-config-diff"
        >
          {diff.map((l, i) => (
            <div
              key={i}
              className={
                l.kind === "add"
                  ? "text-success"
                  : l.kind === "del"
                    ? "text-error"
                    : "text-description-muted"
              }
            >
              <span aria-hidden="true">
                {l.kind === "add"
                  ? "+ "
                  : l.kind === "del"
                    ? "- "
                    : l.kind === "gap"
                      ? "  ..."
                      : "  "}
              </span>
              {l.kind === "add" && <span className="sr-only">added: </span>}
              {l.kind === "del" && <span className="sr-only">removed: </span>}
              {l.text}
            </div>
          ))}
        </pre>
      )}
      <p className="m-0 text-2xs text-description-muted">
        Comments and every setting not shown here are kept.
      </p>
    </div>
  );
}
