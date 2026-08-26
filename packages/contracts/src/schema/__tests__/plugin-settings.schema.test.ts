import { describe, expect, it } from 'vitest';
import { PluginManifestSchema, PluginObjectArrayFieldSchema } from '../plugin.schema';
import { WSPluginUserActionResultMessageSchema } from '../websocket.schema';

describe('PluginObjectArrayFieldSchema (row-level control fields)', () => {
  it('accepts legacy string/number/boolean rows', () => {
    expect(PluginObjectArrayFieldSchema.parse({ key: 'name', type: 'string', label: 'Name' }).type).toBe('string');
    expect(PluginObjectArrayFieldSchema.parse({ key: 'n', type: 'number', label: 'N' }).type).toBe('number');
    expect(PluginObjectArrayFieldSchema.parse({ key: 'b', type: 'boolean', label: 'B' }).type).toBe('boolean');
  });

  it('rejects reserved object property names as field keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => PluginObjectArrayFieldSchema.parse({ key, type: 'string', label: 'X' })).toThrow();
    }
  });

  it('accepts new row control types with options/actionId/fullWidth', () => {
    const method = PluginObjectArrayFieldSchema.parse({
      key: 'method',
      type: 'radio',
      label: 'Method',
      options: [
        { value: 'POST', label: 'POST' },
        { value: 'GET', label: 'GET' },
      ],
      default: 'POST',
    });
    expect(method.type).toBe('radio');
    expect(method.options).toHaveLength(2);
    expect(method.default).toBe('POST');

    const events = PluginObjectArrayFieldSchema.parse({
      key: 'events',
      type: 'multiselect',
      label: 'Events',
      options: [{ value: 'decode', label: 'Decode' }],
      fullWidth: true,
    });
    expect(events.fullWidth).toBe(true);

    expect(PluginObjectArrayFieldSchema.parse({ key: 'headers', type: 'string[]', label: 'Headers' }).type)
      .toBe('string[]');
    expect(PluginObjectArrayFieldSchema.parse({
      key: 'test',
      type: 'action',
      label: 'Test',
      actionId: 'test',
    }).actionId).toBe('test');
  });

  it('rejects radio/multiselect rows without options', () => {
    expect(() => PluginObjectArrayFieldSchema.parse({ key: 'm', type: 'radio', label: 'M' })).toThrow();
    expect(() => PluginObjectArrayFieldSchema.parse({ key: 'e', type: 'multiselect', label: 'E' })).toThrow();
  });

  it('rejects rows with duplicate option values', () => {
    expect(() => PluginObjectArrayFieldSchema.parse({
      key: 'e',
      type: 'multiselect',
      label: 'E',
      options: [
        { value: 'a', label: 'A' },
        { value: 'a', label: 'A2' },
      ],
    })).toThrow();
  });

  it('still rejects unknown row types and manifests with the new row controls load', () => {
    expect(() => PluginObjectArrayFieldSchema.parse({ key: 'x', type: 'unknown', label: 'X' })).toThrow();

    const manifest = PluginManifestSchema.parse({
      name: 'webhook-push-test',
      version: '0.1.0',
      type: 'utility',
      apiVersion: 2,
      settings: {
        targets: {
          type: 'object[]',
          label: 'Targets',
          default: [],
          scope: 'operator',
          itemFields: [
            { key: 'name', type: 'string', label: 'Name' },
            { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
            {
              key: 'method',
              type: 'radio',
              label: 'Method',
              options: [
                { value: 'POST', label: 'POST' },
                { value: 'GET', label: 'GET' },
              ],
              default: 'POST',
            },
            { key: 'headers', type: 'string[]', label: 'Headers', fullWidth: true },
            {
              key: 'events',
              type: 'multiselect',
              label: 'Events',
              options: [{ value: 'decode', label: 'Decode' }],
              fullWidth: true,
            },
            { key: 'test', type: 'action', label: 'Test', fullWidth: true },
          ],
        },
      },
    });
    expect(manifest.settings?.targets.itemFields).toHaveLength(6);
  });
});

describe('WSPluginUserActionResultMessageSchema', () => {
  it('validates the round-trip result message shape with a requestId', () => {
    const message = WSPluginUserActionResultMessageSchema.parse({
      type: 'pluginUserActionResult',
      timestamp: new Date().toISOString(),
      data: {
        pluginName: 'webhook-push',
        actionId: 'test:0',
        operatorId: 'op-1',
        requestId: 'req-1',
        result: { ok: true, messageKey: 'testOk', params: { target: 'Primary', status: '200' } },
      },
    });
    expect(message.data.requestId).toBe('req-1');
    expect(message.data.actionId).toBe('test:0');
    expect(message.data.result).toMatchObject({ ok: true, messageKey: 'testOk' });
  });
});