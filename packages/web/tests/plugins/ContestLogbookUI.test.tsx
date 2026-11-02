// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../plugin-api/contest-logbook-ui/src/App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  let confirmed = false;
  const invoke = vi.fn(async (action: string, data?: unknown) => {
    if (action === 'save-settings') {
      if ((data as { contestYear: string }).contestYear !== '2026') throw new Error('Contest year is invalid');
      confirmed = true;
      return;
    }
    return {
      schemaVersion: 1, contest: { id: 'test', editionId: '2026', rulesetVersion: '1' },
      health: { state: confirmed ? 'ready' : 'opening', readable: true, writable: confirmed },
      settings: { value: { contestYear: 2025 }, valid: confirmed,
        issues: confirmed ? [] : ['Contest settings require confirmation'],
        fields: [{ key: 'contestYear', type: 'number' }] },
      score: { claimedScore: 0, qsoPoints: 0, multiplierCount: 0 }, qsos: [],
      review: { pendingCount: 0, issues: [] }, import: { state: 'idle' }, export: { formats: [] },
    };
  });
  Object.defineProperty(window, 'tx5dr', { configurable: true, value: {
    locale: 'en', theme: 'dark', ready: Promise.resolve(), invoke,
    onPush() {}, offPush() {}, onLocaleChange: () => () => {}, onThemeChange: () => () => {},
  } });
  return invoke;
}

describe('Contest log settings confirmation', () => {
  it('submits edited settings while the persisted state is still unconfirmed', async () => {
    const invoke = setup();
    render(<App />);
    await screen.findByText('Contest settings require confirmation');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Contest year' }), { target: { value: '2026' } });
    fireEvent.click(save);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save-settings', { contestYear: '2026' }));
    await waitFor(() => expect(screen.queryByText('Contest settings require confirmation')).toBeNull());
  });

  it('shows plugin validation failures and allows correction without confirming invalid settings', async () => {
    const invoke = setup();
    render(<App />);
    await screen.findByText('Contest settings require confirmation');
    const field = screen.getByRole('spinbutton', { name: 'Contest year' });
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Contest year is invalid');
    expect(screen.getByText('Contest settings require confirmation')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(field, { target: { value: '2026' } });
    fireEvent.click(save);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save-settings', { contestYear: '2026' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
