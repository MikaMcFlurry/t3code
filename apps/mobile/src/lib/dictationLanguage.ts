/** Languages Apple's on-device transcriber supports, named in their own language. */
export const DICTATION_LANGUAGES = [
  { locale: "de-DE", label: "Deutsch" },
  { locale: "en-US", label: "English (US)" },
  { locale: "en-GB", label: "English (UK)" },
  { locale: "es-ES", label: "Español" },
  { locale: "fr-FR", label: "Français" },
  { locale: "it-IT", label: "Italiano" },
  { locale: "pt-BR", label: "Português (Brasil)" },
] as const;

/** `auto` follows the device language. */
export type DictationLanguage = "auto" | (typeof DICTATION_LANGUAGES)[number]["locale"];

export const DEFAULT_DICTATION_LANGUAGE: DictationLanguage = "auto";

export function isDictationLanguage(value: unknown): value is DictationLanguage {
  return value === "auto" || DICTATION_LANGUAGES.some((language) => language.locale === value);
}
