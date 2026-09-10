import type {
  CapabilityDescriptor,
  CapabilityState,
  CapabilityValue,
} from '@tx5dr/contracts';
import type { IRadioConnection } from '../connections/IRadioConnection.js';

export type CapabilityRuntimeValue = CapabilityState['value'];
export type ReadFn = (conn: IRadioConnection) => Promise<CapabilityRuntimeValue>;
export interface CapabilityWriteResult {
  value?: CapabilityValue;
  meta?: Record<string, unknown>;
  /** False for send-only operations: do not manufacture an applied state. */
  confirmed?: boolean;
}
export type WriteFn = (conn: IRadioConnection, value: CapabilityValue) => Promise<CapabilityWriteResult | void>;
export type ActionFn = (conn: IRadioConnection) => Promise<void>;
export type CapabilitySupportSource = 'static-caps' | 'runtime-probe' | 'backend-declared';
export type ProbeSupportResult = boolean | {
  supported: boolean;
  source: CapabilitySupportSource;
};
export type ProbeFn = (conn: IRadioConnection) => Promise<ProbeSupportResult>;
export type DescriptorResolver = (conn: IRadioConnection) => Promise<CapabilityDescriptor>;

export interface CapabilityDefinition {
  id: string;
  descriptor: CapabilityDescriptor;
  probeSupport: ProbeFn;
  read?: ReadFn;
  write?: WriteFn;
  action?: ActionFn;
  resolveDescriptor?: DescriptorResolver;
  /** 读取附加元数据（如 split 的 TX 频率），合并到 CapabilityState.meta */
  readMeta?: (conn: IRadioConnection) => Promise<Record<string, unknown> | undefined>;
  /** Backend-owned state, including unknown/unavailable values. Force is for explicit refresh. */
  readState?: (conn: IRadioConnection, force: boolean) => Promise<Omit<CapabilityState, 'id' | 'updatedAt'>>;
}

export interface CapabilityGroupDefinition {
  id: string;
  members: string[];
  write: (values: Record<string, CapabilityValue>) => Promise<void>;
}

/** Optional connection bindings, consumed by the same capability runtime as static definitions. */
export interface RadioCapabilityBindings {
  definitions: CapabilityDefinition[];
  groups: CapabilityGroupDefinition[];
  subscribe: (listener: (states: CapabilityState[]) => void, descriptorsChanged: () => void) => () => void;
}

export interface CapabilityRuntimeEvents {
  capabilityList: (data: { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] }) => void;
  capabilityChanged: (state: CapabilityState) => void;
}
