import i18n from '../i18n/index';

/**
 * 从已注册的插件命名空间中翻译 label
 * label 格式：直接是 i18n key，例如 "autoReplyToCQ"
 * 命名空间：plugin:{pluginName}
 *
 * 如果找不到翻译，返回 label 原文
 */
export function resolvePluginLabel(label: string, pluginName: string): string {
  const ns = `plugin:${pluginName}`;
  // 检查是否已注册该命名空间
  if (i18n.hasResourceBundle(i18n.language, ns)) {
    const translated = i18n.t(label, { ns });
    // i18next 找不到 key 时返回 key 本身
    if (translated !== label) return translated;
  }
  // fallback：尝试 en
  if (i18n.hasResourceBundle('en', ns)) {
    const enTranslated = i18n.t(label, { ns, lng: 'en' });
    if (enTranslated !== label) return enTranslated;
  }
  // 最终 fallback：直接返回 label 原文
  return label;
}

export function resolvePluginName(
  pluginName: string,
  fallback?: string,
): string {
  const translated = resolvePluginLabel('pluginName', pluginName);
  if (translated !== 'pluginName') {
    return translated;
  }
  return fallback ?? pluginName;
}

export function resolvePluginDescription(
  pluginName: string,
  fallback?: string,
): string | undefined {
  const translated = resolvePluginLabel('pluginDescription', pluginName);
  if (translated !== 'pluginDescription') {
    return translated;
  }
  return fallback;
}

/**
 * 将插件携带的 locales 注册到 i18n
 * 在收到 pluginList 事件时调用
 */
export function registerPluginLocales(
  pluginName: string,
  locales: Record<string, Record<string, string>> | undefined,
): void {
  if (!locales) return;
  const ns = `plugin:${pluginName}`;
  for (const [lang, translations] of Object.entries(locales)) {
    i18n.addResourceBundle(lang, ns, translations, true, true);
  }
}
