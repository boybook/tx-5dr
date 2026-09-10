import { WriteCapabilityGroupPayloadSchema, type CapabilityDescriptor, type CapabilityState, type CapabilityValue } from '@tx5dr/contracts';

/** Build only a complete declared group; no native control names or target are accepted. */
export function buildCapabilityGroupPayload(descriptors: CapabilityDescriptor[], values: Record<string, CapabilityValue>) {
  const group = descriptors[0]?.writeGroup;
  const sessionId = descriptors[0]?.sessionId;
  if (!group || !sessionId || descriptors.some((d) => d.writeGroup?.id !== group.id || d.sessionId !== sessionId)
    || group.members.length !== descriptors.length || group.members.some((id) => !descriptors.some((d) => d.id === id))) {
    throw new Error('Inconsistent capability group');
  }
  if (descriptors.some((d) => JSON.stringify(d.target) !== JSON.stringify(descriptors[0].target))) throw new Error('Inconsistent capability targets');
  if (Object.keys(values).length !== group.members.length || group.members.some((id) => !Object.prototype.hasOwnProperty.call(values, id))) {
    throw new Error('Incomplete capability group');
  }
  for (const d of descriptors) {
    const value = values[d.id];
    if (d.valueType === 'number') {
      const limits = d.range ?? d.limits;
      if (typeof value !== 'number' || !Number.isFinite(value)
        || (limits?.min !== undefined && value < limits.min) || (limits?.max !== undefined && value > limits.max)) throw new Error('Invalid numeric group value');
    }
    if (d.valueType === 'boolean' && typeof value !== 'boolean') throw new Error('Invalid boolean group value');
    if (d.valueType === 'enum' && !d.options?.some(option => option.value === value)) throw new Error('Invalid enum group value');
  }
  for (const [low, high] of [['rx_filter_low', 'rx_filter_high'], ['tx_filter_low', 'tx_filter_high']]) {
    if (typeof values[low] === 'number' && typeof values[high] === 'number' && values[low] >= values[high]) throw new Error('Invalid filter boundaries');
  }
  return WriteCapabilityGroupPayloadSchema.parse({ groupId: group.id, sessionId, values });
}

export function getCapabilityGroupValues(descriptors: CapabilityDescriptor[], states: Map<string, CapabilityState>): Record<string, CapabilityValue> {
  const values: Record<string, CapabilityValue> = {};
  for (const d of descriptors) {
    const value = states.get(d.id)?.value;
    if (value !== null && value !== undefined) values[d.id] = value;
  }
  return values;
}
