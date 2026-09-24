// @vitest-environment jsdom
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImagePersistenceNotice } from './ImagePersistenceNotice';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
describe('image persistence notice', () => {
  it('does not show warnings for healthy data', () => {
    render(<ImagePersistenceNotice persistence={{ available: true, stores: [] }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it.each(['salvaged', 'rebuilt', 'backup_restored'] as const)('explains %s without exposing local paths', reason => {
    render(<ImagePersistenceNotice persistence={{ available: true, stores: [{ store: 'artifacts', state: 'recovered', reason, retainedRecords: 1, rejectedRecords: 1 }] }} />);
    expect(screen.getByRole('status').textContent).toContain(`persistence.${reason === 'backup_restored' ? 'restored' : reason}`);
    expect(screen.getByRole('status').textContent).toContain('persistence.originalsPreserved');
  });
  it('explains that newer data requires newer software', () => {
    render(<ImagePersistenceNotice persistence={{ available: false, stores: [{ store: 'templates', state: 'unavailable', reason: 'future_version', retainedRecords: 0, rejectedRecords: 0 }] }} />);
    expect(screen.getByRole('status').textContent).toContain('persistence.futureVersion');
  });
  it('shows repair guidance when the module cannot open its data', () => {
    render(<ImagePersistenceNotice persistence={{ available: false, stores: [] }} />);
    expect(screen.getByRole('status').textContent).toContain('persistence.unavailable');
    expect(screen.getByRole('status').textContent).toContain('persistence.restartAfterRepair');
  });
});
