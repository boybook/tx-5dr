import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// 中文语言包
import zhCommon from './locales/zh/common.json';
import zhToast from './locales/zh/toast.json';
import zhRadio from './locales/zh/radio.json';
import zhSettings from './locales/zh/settings.json';
import zhLogbook from './locales/zh/logbook.json';
import zhAuth from './locales/zh/auth.json';
import zhErrors from './locales/zh/errors.json';

// 英文语言包
import enCommon from './locales/en/common.json';
import enToast from './locales/en/toast.json';
import enRadio from './locales/en/radio.json';
import enSettings from './locales/en/settings.json';
import enLogbook from './locales/en/logbook.json';
import enAuth from './locales/en/auth.json';
import enErrors from './locales/en/errors.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'zh',
    defaultNS: 'common',
    ns: ['common', 'toast', 'radio', 'settings', 'logbook', 'auth', 'errors'],
    detection: {
      order: ['localStorage'],
      lookupLocalStorage: 'tx5dr-language',
      caches: ['localStorage'],
    },
    resources: {
      zh: {
        common: zhCommon,
        toast: zhToast,
        radio: zhRadio,
        settings: zhSettings,
        logbook: zhLogbook,
        auth: zhAuth,
        errors: zhErrors,
      },
      en: {
        common: enCommon,
        toast: enToast,
        radio: enRadio,
        settings: enSettings,
        logbook: enLogbook,
        auth: enAuth,
        errors: enErrors,
      },
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
