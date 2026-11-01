'use client';
import {useCallback, useSyncExternalStore} from 'react';
import {getInterfaceLocale, subscribeInterfaceLocale} from './host-runtime';
import type {InterfaceLocale} from './locale';
import en from '../messages/en.json';
import ru from '../messages/ru.json';
import es from '../messages/es.json';
import de from '../messages/de.json';
import fr from '../messages/fr.json';

const catalogues: Record<InterfaceLocale, Record<string, string>> = {en, ru, es, de, fr};
/** Plain-text messages: React escapes interpolated values. Never use as HTML. */
export function translatePointer(locale: InterfaceLocale, text: string, values?: Record<string, string | number>) {
  const message = Object.hasOwn(catalogues[locale], text) ? catalogues[locale][text]
    : Object.hasOwn(catalogues.en, text) ? catalogues.en[text] : text;
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (token, name: string) => values?.[name] === undefined ? token : String(values[name]));
}
export function usePointerTranslations() {
  const locale = useSyncExternalStore(subscribeInterfaceLocale, getInterfaceLocale, () => 'en' as const);
  return Object.assign(useCallback((text: string, values?: Record<string, string | number>) => translatePointer(locale, text, values), [locale]), {locale});
}

/** Format only interface data with the resolved host locale. */
export function createPointerFormats(locale: InterfaceLocale) {
  const number = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value);
  return {
    metric: (value: number | null | undefined, suffix = "") => value == null
      ? translatePointer(locale, "Unknown")
      : `${number(value, {minimumFractionDigits: value >= 100 ? 0 : 1, maximumFractionDigits: value >= 100 ? 0 : 1})}${suffix}`,
    price: (value: number | null, digits?: number) => value == null ? translatePointer(locale, "Unknown")
      : number(value, {style: "currency", currency: "USD", minimumFractionDigits: digits ?? (value < 1 ? 3 : 2), maximumFractionDigits: digits ?? (value < 1 ? 3 : 2)}),
    tokens: (value: number | null) => value == null ? translatePointer(locale, "Unknown") : number(value, {notation: "compact"}),
    number,
    date: (value: number | string | Date) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? translatePointer(locale, "Not reported") : new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short"}).format(date);
    },
  };
}

export function usePointerFormats() {
  return createPointerFormats(usePointerTranslations().locale);
}
