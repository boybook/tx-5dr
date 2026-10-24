import { describe, it, expect } from 'vitest';
import { ReleaseManifestSchema, UpdatePreferencesSchema } from './update.schema.js';
const legacy = { product: 'server', channel: 'release', tag: 'v1.0.0', version: '1.0.0', commit: 'abcdef1', published_at: '2026-10-24T00:00:00Z', assets: [] };
describe('release contract', () => {
  it('supports legacy short commits but requires full identity for versioned manifests', () => {
    expect(ReleaseManifestSchema.safeParse(legacy).success).toBe(true);
    expect(ReleaseManifestSchema.safeParse({ ...legacy, schema_version: 1 }).success).toBe(false);
    expect(ReleaseManifestSchema.safeParse({ ...legacy, schema_version: 1, commit: 'a'.repeat(40) }).success).toBe(true);
  });
  it('rejects unknown channels, schema versions and unsafe asset paths', () => {
    expect(UpdatePreferencesSchema.safeParse({ channel: 'beta' }).success).toBe(false);
    expect(ReleaseManifestSchema.safeParse({ ...legacy, schema_version: 2 }).success).toBe(false);
    expect(ReleaseManifestSchema.safeParse({ ...legacy, assets: [{ name: '../package.deb', url: 'http://example.com/package.deb', size: 1, sha256: 'bad' }] }).success).toBe(false);
  });
});
