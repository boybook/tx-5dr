import { describe, expect, it } from 'vitest';
import { interpolateText, resolveTranslationLocale, translateMessage } from './useI18n.js';

describe('plugin UI i18n helpers', () => {
  const translations = {
    zh: { title: '设置', repeated: '{name} 呼叫 {name}' },
    en: { title: 'Settings', fallbackOnly: 'Fallback {count}' },
  };

  it('falls back from regional locale to base language', () => {
    expect(resolveTranslationLocale(translations, 'zh-CN')).toBe('zh');
  });

  it('falls back to English when locale is not available', () => {
    expect(resolveTranslationLocale(translations, 'ja-JP')).toBe('en');
  });

  it('replaces every matching interpolation placeholder', () => {
    expect(interpolateText(translations.zh.repeated, { name: 'BA1ABC' })).toBe('BA1ABC 呼叫 BA1ABC');
  });

  it('leaves missing interpolation placeholders intact', () => {
    expect(interpolateText('Hello {name} {missing}', { name: 'World' })).toBe('Hello World {missing}');
  });

  it('falls back to English keys before returning the key name', () => {
    expect(translateMessage(translations, 'zh-CN', 'fallbackOnly', { count: 3 })).toBe('Fallback 3');
    expect(translateMessage(translations, 'zh-CN', 'missingKey')).toBe('missingKey');
  });
});
