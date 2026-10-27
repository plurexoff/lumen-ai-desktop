// UI strings. English is the source of truth; Russian must cover the same keys.
// Strings live in per-module fragments under src/locales/ and are merged here.
// Usage in components: const t=useT(); then t('area.key') or t('area.key',{n:3}).
// Use plain t() (non-hook) only outside React render (handlers, module code).
import { useApp } from './store';
import { appEn, appRu } from './locales/app';
import { settingsEn, settingsRu } from './locales/settings';
import { sidebarEn, sidebarRu } from './locales/sidebar';
import { chatEn, chatRu } from './locales/chat';

export type Dict = Record<string, string>;

const en: Dict = { ...appEn, ...settingsEn, ...sidebarEn, ...chatEn };
const ru: Dict = { ...appRu, ...settingsRu, ...sidebarRu, ...chatRu };

export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = useApp.getState().settings.language;
  let s = (lang === 'ru' ? ru[key] : undefined) ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

// React hook: subscribes to the language setting so components re-render on change.
export function useT() {
  useApp((s) => s.settings.language);
  return t;
}
