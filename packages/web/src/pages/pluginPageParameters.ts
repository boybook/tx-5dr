const RESERVED_PARAMS = new Set(['pluginName', 'pageId', 'operatorId', 'auth_token']);

export interface PluginPageParameters {
  pluginName: string;
  pageId: string;
  operatorId?: string;
  params: Record<string, string>;
  valid: boolean;
}

export function resolvePluginPageParameters(search: string): PluginPageParameters {
  const query = new URLSearchParams(search);
  const pluginName = query.get('pluginName')?.trim() ?? '';
  const pageId = query.get('pageId')?.trim() ?? '';
  const operatorId = query.get('operatorId')?.trim() || undefined;
  const params: Record<string, string> = {};

  query.forEach((value, key) => {
    if (!RESERVED_PARAMS.has(key)) {
      params[key] = value;
    }
  });
  if (operatorId) {
    params.operatorId = operatorId;
  }

  return {
    pluginName,
    pageId,
    operatorId,
    params,
    valid: pluginName.length > 0 && pageId.length > 0,
  };
}
