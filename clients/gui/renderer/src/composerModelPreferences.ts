import type { ComposerModelOption } from "./ComposerModelMenu.js";

const favoriteKey = "areal-gui:favorite-models:v1";
export function readFavoriteModels(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(favoriteKey) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
      : [];
  } catch {
    return [];
  }
}
export function saveFavoriteModels(values: string[]) {
  localStorage.setItem(favoriteKey, JSON.stringify(values));
}
export function filterComposerModels(
  options: ComposerModelOption[],
  query: string,
  favorites?: readonly string[],
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return options.filter(
    (option) =>
      (!favorites || favorites.includes(option.value)) &&
      words.every((word) =>
        [option.value, option.label, option.providerId, option.providerName]
          .join(" ")
          .toLocaleLowerCase()
          .includes(word),
      ),
  );
}
