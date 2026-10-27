import { type ResolvedAppearance, tokensForAppearance } from "@rakazo/ui-tokens";

const THEME_COLOR_META = 'meta[name="theme-color"]';

export function applyResolvedAppearance(
  appearance: ResolvedAppearance,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): void {
  if (!root) return;
  root.dataset.theme = appearance;
  root.style.colorScheme = appearance;
  if (typeof document === "undefined") return;
  const meta = document.querySelector(THEME_COLOR_META);
  if (meta) {
    meta.setAttribute("content", tokensForAppearance(appearance).background);
  }
}

/** Web and desktop are dark only, like BE Hub and BE Voice. */
export function applyUiAppearance(): ResolvedAppearance {
  applyResolvedAppearance("dark");
  return "dark";
}
