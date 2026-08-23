export type PluginDataSnapshotMode = 'structured' | 'json';

export class PluginDataBoundaryError extends Error {
  readonly code = 'PLUGIN_DATA_NOT_SERIALIZABLE';

  constructor(
    readonly mode: PluginDataSnapshotMode,
    readonly valuePath: string,
    readonly valueType: string,
    readonly reason: 'capability' | 'accessor' | 'clone',
    message: string,
  ) {
    super(message);
    this.name = 'PluginDataBoundaryError';
  }
}

const capabilityValues = new WeakSet<object>();
const detachedHostValues = new WeakSet<object>();

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Buffer.isBuffer(value)) return 'Buffer';
  if (Array.isArray(value)) return 'Array';
  if (typeof value === 'object') return value.constructor?.name || 'Object';
  return typeof value;
}

function hasCapabilityPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype !== Object.prototype
    && prototype !== null
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Map)
    && !(value instanceof Set)
    && !(value instanceof RegExp)
    && !(value instanceof ArrayBuffer)
    && !ArrayBuffer.isView(value);
}

export function markPluginCapability<T>(value: T): T {
  if (isObjectLike(value)) {
    capabilityValues.add(value);
  }
  return value;
}

export function markDetachedPluginData<T>(value: T): T {
  if (isObjectLike(value)) detachedHostValues.add(value);
  return value;
}

export function isDetachedPluginData(value: unknown): boolean {
  return isObjectLike(value) && detachedHostValues.has(value);
}

function containsCapabilityMember(value: object, seen = new WeakSet<object>()): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) return true;
    if (!('value' in descriptor) || !isObjectLike(descriptor.value)) continue;
    if (typeof descriptor.value === 'function') return true;
    if (hasCapabilityPrototype(descriptor.value)) return true;
    if (containsCapabilityMember(descriptor.value, seen)) return true;
  }
  return false;
}

/** Marks a host-owned capability and statically attached child ports without invoking getters. */
export function markPluginCapabilityTree<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isObjectLike(value) || seen.has(value)) return value;
  seen.add(value);
  capabilityValues.add(value);

  const prototype = Object.getPrototypeOf(value);
  if (typeof value !== 'function'
      && prototype !== Object.prototype
      && prototype !== null) {
    return value;
  }

  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor && isObjectLike(descriptor.value)) {
      if (typeof descriptor.value === 'function'
          || hasCapabilityPrototype(descriptor.value)
          || containsCapabilityMember(descriptor.value)) {
        markPluginCapabilityTree(descriptor.value, seen);
      }
    }
  }
  return value;
}

export function isPluginCapability(value: unknown): boolean {
  return isObjectLike(value) && capabilityValues.has(value);
}

function assertNoPluginCapabilities(
  value: unknown,
  mode: PluginDataSnapshotMode,
  path = '$',
  seen = new WeakSet<object>(),
): void {
  if (!isObjectLike(value)) return;
  if (isPluginCapability(value)) {
    throw new PluginDataBoundaryError(
      mode,
      path,
      describeType(value),
      'capability',
      `Plugin data at ${path} contains a host capability`,
    );
  }
  if (typeof value === 'function' || seen.has(value)) return;
  seen.add(value);

  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    throw new PluginDataBoundaryError(
      mode,
      path,
      'SharedArrayBuffer',
      'clone',
      `Plugin data at ${path} contains shared memory`,
    );
  }
  if (typeof SharedArrayBuffer !== 'undefined'
      && ArrayBuffer.isView(value)
      && value.buffer instanceof SharedArrayBuffer) {
    throw new PluginDataBoundaryError(
      mode,
      path,
      describeType(value),
      'clone',
      `Plugin data at ${path} contains a shared-memory view`,
    );
  }

  if (mode === 'structured' && value instanceof Map) {
    let index = 0;
    for (const [key, entry] of value) {
      assertNoPluginCapabilities(key, mode, `${path}.<map-key:${index}>`, seen);
      assertNoPluginCapabilities(entry, mode, `${path}.<map-value:${index}>`, seen);
      index += 1;
    }
    return;
  }
  if (mode === 'structured' && value instanceof Set) {
    let index = 0;
    for (const entry of value) {
      assertNoPluginCapabilities(entry, mode, `${path}.<set:${index}>`, seen);
      index += 1;
    }
    return;
  }

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) {
      assertNoPluginCapabilities(descriptor.value, mode, `${path}.${key}`, seen);
    }
  }
}

export function snapshotPluginData<T>(value: T, mode: PluginDataSnapshotMode): T {
  assertNoPluginCapabilities(value, mode);

  try {
    if (mode === 'json') {
      const serialized = JSON.stringify(value, (_key, entry) => {
        if (isPluginCapability(entry)) {
          throw new PluginDataBoundaryError(
            mode,
            '$',
            describeType(entry),
            'capability',
            'Plugin data contains a host capability',
          );
        }
        return entry;
      });
      return (serialized === undefined ? undefined : JSON.parse(serialized)) as T;
    }
    if (Buffer.isBuffer(value)) {
      return Buffer.from(value) as T;
    }
    const snapshot = structuredClone(value);
    assertNoPluginCapabilities(snapshot, mode);
    return snapshot;
  } catch (error) {
    if (error instanceof PluginDataBoundaryError) throw error;
    throw new PluginDataBoundaryError(
      mode,
      '$',
      describeType(value),
      'clone',
      `Plugin data could not cross the ${mode} boundary`,
    );
  }
}
