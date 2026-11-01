export const interfaceLocales = ['en', 'ru', 'es', 'de', 'fr'] as const;
export type InterfaceLocale = typeof interfaceLocales[number];
export function resolveInterfaceLocale(value: unknown): InterfaceLocale {
  if (typeof value !== 'string') return 'en';
  const base = value.trim().toLowerCase().replaceAll('_', '-').split('-')[0];
  return interfaceLocales.includes(base as InterfaceLocale) ? base as InterfaceLocale : 'en';
}
