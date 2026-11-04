// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginStatus } from '@tx5dr/contracts';
import zh from '../../../i18n/locales/zh/settings.json';
import { PluginAutoDisableDetails } from '../PluginAutoDisableDetails';
import { PluginCard } from '../PluginList';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: { number?: number }) => {
      const value = key.split('.').reduce<unknown>((entry, part) =>
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[part] : undefined, zh);
      return typeof value === 'string' ? value.replace('{{number}}', String(options?.number)) : key;
    },
  }),
}));

afterEach(cleanup);

function plugin(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    name: 'diagnostic-plugin', version: '1.0.0', type: 'utility', instanceScope: 'global',
    isBuiltIn: false, loaded: true, enabled: true, autoDisabled: true, errorCount: 0,
    ...overrides,
  };
}

describe('PluginAutoDisableDetails', () => {
  it('keeps the detail trigger, plugin selection and enable switch as separate controls', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const toggle = vi.fn();
    const status = plugin();
    render(<PluginCard plugin={status} selected={false} onSelect={select} onToggle={toggle} />);
    await user.click(screen.getByRole('button', { name: zh.plugins.disableDetailsAction }));
    expect(await screen.findByText(zh.plugins.disableDetailsTitle)).toBeTruthy();
    expect(select).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(zh.plugins.disableDetailsTitle)).toBeNull());
    await user.click(screen.getByRole('button', { name: /diagnostic-plugin/ }));
    expect(select).toHaveBeenCalledWith(status);
    select.mockClear();
    await user.click(screen.getByRole('switch'));
    expect(toggle).toHaveBeenCalledWith(status, false);
    expect(select).not.toHaveBeenCalled();
  });
  it('opens with the keyboard and shows the exact triggering error without a positive error count', async () => {
    const user = userEvent.setup();
    const message = 'startup failed\nwith a detailed explanation';
    render(<PluginAutoDisableDetails plugin={plugin({ autoDisableInfo: {
      reason: 'load-failed', timestamp: 1700000000000, operation: 'onLoad', message,
      errors: [{ timestamp: 1700000000000, operation: 'onLoad', message }],
    } })} />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(zh.plugins.disableReasons['load-failed'])).toBeTruthy();
    expect(screen.getByText('onLoad')).toBeTruthy();
    expect(screen.getByText('startup failed with a detailed explanation')).toBeTruthy();
    expect(screen.getByText(zh.plugins.disableTrigger)).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(zh.plugins.disableReasons['load-failed'])).toBeNull());
  });

  it('shows all five failures and identifies the final one', async () => {
    const user = userEvent.setup();
    const errors = Array.from({ length: 5 }, (_, i) => ({ timestamp: 1700000000000 + i, operation: 'onTimer', message: `failed-${i + 1}` }));
    render(<PluginAutoDisableDetails plugin={plugin({ autoDisableInfo: {
      reason: 'consecutive-errors', timestamp: errors[4].timestamp, operation: 'onTimer', message: 'failed-5', errors,
    } })} />);
    await user.click(screen.getByRole('button', { name: zh.plugins.disableDetailsAction }));
    expect(await screen.findAllByRole('listitem')).toHaveLength(5);
    const trigger = screen.getByText(zh.plugins.disableTrigger);
    expect(trigger.closest('li')?.textContent).toContain('failed-5');
    expect(screen.getAllByText(zh.plugins.disableTrigger)).toHaveLength(1);
  });

  it('opens legacy statuses and explains missing details instead of rendering an empty popover', async () => {
    const user = userEvent.setup();
    const view = render(<PluginAutoDisableDetails plugin={plugin({ lastError: 'legacy failure' })} />);
    await user.click(screen.getByRole('button', { name: zh.plugins.disableDetailsAction }));
    expect(await screen.findByText('legacy failure')).toBeTruthy();
    view.rerender(<PluginAutoDisableDetails plugin={plugin()} />);
    expect(await screen.findByText(zh.plugins.disableDetailsUnavailable)).toBeTruthy();
  });
});
