import type {
  CapabilityDescriptor,
  CapabilityState,
  CapabilityValue,
} from '@tx5dr/contracts';
import type { IRadioConnection } from '../connections/IRadioConnection.js';

export type CapabilityRuntimeValue = CapabilityState['value'];
export type ReadFn = (conn: IRadioConnection) => Promise<CapabilityRuntimeValue>;
export type WriteFn = (conn: IRadioConnection, value: CapabilityValue) => Promise<void>;
export type ActionFn = (conn: IRadioConnection) => Promise<void>;
export type ProbeFn = (conn: IRadioConnection) => Promise<boolean>;
export type DescriptorResolver = (conn: IRadioConnection) => Promise<CapabilityDescriptor>;

export interface CapabilityDefinition {
  id: string;
  descriptor: CapabilityDescriptor;
  probeSupport: ProbeFn;
  read?: ReadFn;
  write?: WriteFn;
  action?: ActionFn;
  resolveDescriptor?: DescriptorResolver;
}

export interface CapabilityRuntimeEvents {
  capabilityList: (data: { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] }) => void;
  capabilityChanged: (state: CapabilityState) => void;
}
