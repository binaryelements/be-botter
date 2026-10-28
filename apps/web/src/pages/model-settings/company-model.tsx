import { Trans, useLingui } from "@lingui/react/macro";
import { CLOUDFLARE_AI_GATEWAY_PROVIDER_ID } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useState } from "react";
import { errorText } from "../../lib/user-error";

import { ModelPicker } from "./model-picker";
import type { ModelSettingsState } from "./use-model-settings";

export function CompanyModel({
  clearCompanyModel,
  companyConnection,
  connectCompanyModel,
  groups,
}: Pick<
  ModelSettingsState,
  "clearCompanyModel" | "companyConnection" | "connectCompanyModel" | "groups"
>) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // BE sites run the company on OpenRouter; any other key-only provider stays one pick away.
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Key-only providers; sign-in and endpoints needing more fields stay personal.
  const options = groups.filter(
    (group) =>
      group.entries[0]?.auth !== "oauth" &&
      !group.entries[0]?.placeholder &&
      group.id !== CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  );
  const group = options.find((entry) => entry.id === provider) ?? options[0];
  const selected = group?.entries.find((entry) => entry.id === modelId) ?? group?.entries[0];
  const connectedGroup = groups.find((entry) => entry.id === companyConnection?.provider);

  async function run(action: () => Promise<void>, fallback: string) {
    setError(null);
    setPending(true);
    try {
      await action();
      setApiKey("");
      setOpen(false);
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      data-testid="company-model"
      className="flex flex-col gap-1 md:flex-row md:items-baseline md:gap-6"
    >
      <span className="shrink-0 text-[13.5px] text-muted-foreground md:w-[310px]">
        <Trans>Company</Trans>
      </span>
      <div className="min-w-0 flex-1">
        {companyConnection ? (
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="truncate text-[15px] text-foreground">{companyConnection.label}</span>
            <span className="truncate text-[13px] leading-[1.5] text-muted-foreground">
              {[connectedGroup?.name ?? companyConnection.provider, companyConnection.modelId]
                .filter((part) => part && part !== companyConnection.label)
                .join(" · ")}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-my-2 text-muted-foreground"
              data-testid="company-model-remove"
              disabled={pending}
              onClick={() => void run(clearCompanyModel, t`Could not disconnect this provider`)}
            >
              <Trans>Remove</Trans>
            </Button>
          </div>
        ) : open && group && selected ? (
          <div className="max-w-[420px]">
            <label
              className="block text-[13.5px] text-muted-foreground"
              htmlFor="company-model-provider"
            >
              <Trans>Provider</Trans>
              <NativeSelect
                id="company-model-provider"
                className="mt-2 w-full text-foreground"
                value={group.id}
                disabled={pending}
                onChange={(event) => {
                  setProvider(event.target.value);
                  setModelId("");
                }}
              >
                {options.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <div className="mt-4 block text-[13.5px] text-muted-foreground">
              <span>
                <Trans>Model</Trans>
              </span>
              <ModelPicker options={group.entries} value={selected.id} onChange={setModelId} />
            </div>
            <label
              className="mt-4 block text-[13.5px] text-muted-foreground"
              htmlFor="company-model-api-key"
            >
              <Trans>API key</Trans>
              <Input
                id="company-model-api-key"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
                type="password"
                autoComplete="new-password"
                className="mt-2 h-10 text-foreground"
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              className="mt-3 rounded-full"
              size="sm"
              disabled={pending || apiKey.trim().length < 8}
              onClick={() =>
                void run(
                  () =>
                    connectCompanyModel({
                      provider: selected.provider,
                      apiKey: apiKey.trim(),
                      modelId: selected.id,
                      label: group.name,
                    }),
                  t`Could not connect this provider`,
                )
              }
            >
              {pending ? <Trans>Saving…</Trans> : <Trans>Connect API key</Trans>}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="company-model-connect"
            disabled={!group}
            onClick={() => setOpen(true)}
          >
            <Trans>Connect for the company</Trans>
          </Button>
        )}
        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
