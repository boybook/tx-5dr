/**
 * CapabilityRegistry - 电台能力组件注册表
 *
 * 每个能力 ID 可以注册：
 * - panelComponent: 在 RadioControlPanel Modal 中的完整控件
 * - surfaceComponent: 在 RadioControl 工具栏 Popover 中的紧凑控件（可选）
 */

import React from 'react';
import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';
import { WSMessageType } from '@tx5dr/contracts';
import { useConnection } from '../store/radioStore';

// ===== 组件 Props 接口 =====

export interface CapabilityComponentProps {
  /** 能力 ID */
  capabilityId: string;
  /** 当前运行时状态（undefined = 尚未收到数据） */
  state: CapabilityState | undefined;
  /** 静态描述符 */
  descriptor: CapabilityDescriptor;
  /** 写入回调（由父组件通过 WS 发送命令） */
  onWrite: (id: string, value?: boolean | number, action?: boolean) => void;
}

export type PanelCapabilityComponent = React.ComponentType<CapabilityComponentProps>;
export type SurfaceCapabilityComponent = React.ComponentType<CapabilityComponentProps>;

interface CapabilityRegistryEntry {
  panel: PanelCapabilityComponent;
  surface?: SurfaceCapabilityComponent;
}

// ===== 注册表 =====

const registry = new Map<string, CapabilityRegistryEntry>();

/**
 * 注册能力组件
 * @param id - 能力 ID
 * @param panel - 面板版本（完整控件，用于 Modal）
 * @param surface - 工具栏版本（紧凑控件，可选）
 */
export function registerCapabilityComponent(
  id: string,
  panel: PanelCapabilityComponent,
  surface?: SurfaceCapabilityComponent,
): void {
  registry.set(id, { panel, surface });
}

/**
 * 获取面板组件（用于 RadioControlPanel）
 */
export function getPanelComponent(id: string): PanelCapabilityComponent | undefined {
  return registry.get(id)?.panel;
}

/**
 * 获取工具栏 surface 组件
 */
export function getSurfaceComponent(id: string): SurfaceCapabilityComponent | undefined {
  return registry.get(id)?.surface;
}

// ===== onWrite Hook =====

/**
 * 返回能力写入回调，通过 WebSocket 发送 WRITE_RADIO_CAPABILITY 命令
 */
export function useCapabilityWriter(): (id: string, value?: boolean | number, action?: boolean) => void {
  const connection = useConnection();

  return React.useCallback(
    (id: string, value?: boolean | number, action?: boolean) => {
      const wsClient = connection.state.radioService?.wsClientInstance;
      if (!wsClient) return;
      wsClient.send(WSMessageType.WRITE_RADIO_CAPABILITY, { id, value, action });
    },
    [connection.state.radioService],
  );
}
