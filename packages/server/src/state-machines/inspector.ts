/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * XState 可视化调试 Inspector 实例
 *
 * 从 index.ts 分离出来，避免状态机测试时间接导入整个服务器入口文件
 */
export let globalInspector: any = null;

export function setGlobalInspector(inspector: any): void {
  globalInspector = inspector;
}
