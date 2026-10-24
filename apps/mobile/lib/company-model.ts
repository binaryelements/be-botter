import type { CompanyModelConnection } from "@rakazo/contracts";
import type { MobileMe, MobileModelCredential } from "./api";

/**
 * Where the active model comes from: the company's shared connection when the
 * person has no connection of their own for that provider, else the provider.
 */
export function activeModelSourceLabel(
  me: MobileMe | null,
  credentials: MobileModelCredential[],
  company: CompanyModelConnection | null,
  providerName: string | undefined,
  t: (message: string) => string,
): string {
  const ownCredential = credentials.some((entry) => entry.provider === me?.defaultProvider);
  if (company && !ownCredential && me?.defaultProvider === company.provider) return t("Company");
  return providerName ?? me?.defaultProvider ?? t("Configured by deployment");
}
