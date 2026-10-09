import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Lang } from "../core/types";
import { ServerError } from "../core/types";
import { setNumberLocale } from "./format";
import { en, type MessageKey } from "./en";
import { pl } from "./pl";

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, pl };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function translator(lang: Lang): Translate {
  const dict = DICTS[lang] ?? en;
  return (key, vars) => {
    let s = dict[key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

/** FR-073: default to the browser language; anything other than Polish falls back to English. */
export function browserLang(): Lang {
  const langs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  return langs.some((l) => l?.toLowerCase().startsWith("pl")) ? "pl" : "en";
}

export const localeOf = (lang: Lang) => (lang === "pl" ? "pl-PL" : "en-GB");

interface I18n {
  lang: Lang;
  t: Translate;
  locale: string;
}

const Ctx = createContext<I18n>({ lang: "en", t: translator("en"), locale: "en-GB" });

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => {
    setNumberLocale(localeOf(lang));
    return { lang, t: translator(lang), locale: localeOf(lang) };
  }, [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

/** Human message for any thrown error. */
export function errorMessage(t: Translate, e: unknown): string {
  if (e instanceof ServerError) return t(`err.${e.code}` as MessageKey);
  return t("common.error");
}
