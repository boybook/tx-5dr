import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getInitialLanguage, SUPPORTED_LANGUAGES } from './language';

// 中文语言包
import zhCommon from './locales/zh/common.json';
import zhToast from './locales/zh/toast.json';
import zhRadio from './locales/zh/radio.json';
import zhSettings from './locales/zh/settings.json';
import zhLogbook from './locales/zh/logbook.json';
import zhAuth from './locales/zh/auth.json';
import zhErrors from './locales/zh/errors.json';
import zhVoice from './locales/zh/voice.json';
import zhAbout from './locales/zh/about.json';

// 日语语言包
import jaCommon from './locales/ja/common.json';
import jaToast from './locales/ja/toast.json';
import jaRadio from './locales/ja/radio.json';
import jaSettings from './locales/ja/settings.json';
import jaLogbook from './locales/ja/logbook.json';
import jaAuth from './locales/ja/auth.json';
import jaErrors from './locales/ja/errors.json';
import jaVoice from './locales/ja/voice.json';
import jaAbout from './locales/ja/about.json';

// 英文语言包
import enCommon from './locales/en/common.json';
import enToast from './locales/en/toast.json';
import enRadio from './locales/en/radio.json';
import enSettings from './locales/en/settings.json';
import enLogbook from './locales/en/logbook.json';
import enAuth from './locales/en/auth.json';
import enErrors from './locales/en/errors.json';
import enVoice from './locales/en/voice.json';
import enAbout from './locales/en/about.json';

i18n
  .use(initReactI18next)
  .init({
    lng: getInitialLanguage(),
    fallbackLng: 'zh',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    defaultNS: 'common',
    ns: ['common', 'toast', 'radio', 'settings', 'logbook', 'auth', 'errors', 'voice', 'about'],
    resources: {
      zh: {
        common: zhCommon,
        toast: zhToast,
        radio: zhRadio,
        settings: zhSettings,
        logbook: zhLogbook,
        auth: zhAuth,
        errors: zhErrors,
        voice: zhVoice,
        about: zhAbout,
      },
      ja: {
        common: jaCommon,
        toast: jaToast,
        radio: jaRadio,
        settings: jaSettings,
        logbook: jaLogbook,
        auth: jaAuth,
        errors: jaErrors,
        voice: jaVoice,
        about: jaAbout,
      },
      en: {
        common: enCommon,
        toast: enToast,
        radio: enRadio,
        settings: enSettings,
        logbook: enLogbook,
        auth: enAuth,
        errors: enErrors,
        voice: enVoice,
        about: enAbout,
      },
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
