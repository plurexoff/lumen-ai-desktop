import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { useApp } from '../src/store';

describe('i18n', () => {
  it('defaults to English', () => {
    expect(useApp.getState().settings.language).toBe('en');
    expect(t('settings.title')).toBe('Settings');
  });

  it('switches to Russian and back', () => {
    useApp.setState((s) => ({ settings: { ...s.settings, language: 'ru' } }));
    expect(t('settings.title')).toBe('Настройки');
    expect(t('sidebar.newConversation')).toBe('Новый разговор');
    useApp.setState((s) => ({ settings: { ...s.settings, language: 'en' } }));
    expect(t('settings.title')).toBe('Settings');
  });

  it('interpolates placeholders in both languages', () => {
    expect(t('sidebar.pin', { title: 'X' })).toBe('Pin X');
    useApp.setState((s) => ({ settings: { ...s.settings, language: 'ru' } }));
    expect(t('sidebar.pin', { title: 'X' })).toBe('Закрепить X');
    useApp.setState((s) => ({ settings: { ...s.settings, language: 'en' } }));
  });

  it('falls back to English when a Russian string is missing', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });
});
