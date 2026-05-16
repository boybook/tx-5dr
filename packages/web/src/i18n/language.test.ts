import { afterEach, describe, expect, it } from 'vitest';
import {
  getDocumentLanguage,
  getIntlLocale,
  getSystemLanguage,
  resolveLanguageMode,
  resolveSupportedLanguage,
} from './language';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
});

describe('i18n language helpers', () => {
  it('maps regional browser languages to supported app languages', () => {
    expect(resolveSupportedLanguage('ja-JP')).toBe('ja');
    expect(resolveSupportedLanguage('ja')).toBe('ja');
    expect(resolveSupportedLanguage('zh-Hans-CN')).toBe('zh');
    expect(resolveSupportedLanguage('en-US')).toBe('en');
    expect(resolveSupportedLanguage('fr-FR')).toBe('en');
  });

  it('accepts supported stored language modes and falls back to system', () => {
    expect(resolveLanguageMode('ja')).toBe('ja');
    expect(resolveLanguageMode('zh')).toBe('zh');
    expect(resolveLanguageMode('en')).toBe('en');
    expect(resolveLanguageMode('system')).toBe('system');
    expect(resolveLanguageMode('fr')).toBe('system');
    expect(resolveLanguageMode(null)).toBe('system');
  });

  it('returns document and Intl locales for Japanese', () => {
    expect(getDocumentLanguage('ja')).toBe('ja-JP');
    expect(getIntlLocale('ja-JP')).toBe('ja-JP');
    expect(getIntlLocale('en-US')).toBe('en-US');
  });

  it('prefers Japanese or Chinese system languages over unsupported browser fallbacks', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        languages: ['fr-FR', 'ja-JP'],
        language: 'fr-FR',
      },
    });

    expect(getSystemLanguage()).toBe('ja');
  });
});
