import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StrategyActionDescriptor, StrategyAttention } from '@tx5dr/contracts';
import {
  OperatorStrategyAttention,
  resolveAttentionActions,
  resolveStandaloneActions,
} from './OperatorStrategyAttention';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));

const actions: StrategyActionDescriptor[] = [{
  id: 'open-settings',
  label: 'Open settings',
  icon: 'file-lines',
  navigation: { kind: 'plugin-page', pageId: 'settings' },
}, {
  id: 'retry',
  label: 'Retry',
}];
const attention: StrategyAttention = {
  id: 'setup-required',
  tone: 'warning',
  title: 'Setup required',
  description: 'Review the configuration.',
  actionIds: ['open-settings'],
};

describe('OperatorStrategyAttention', () => {
  it('resolves referenced actions in attention order and removes duplicate standalone buttons', () => {
    expect(resolveAttentionActions(attention, actions).map((action) => action.id)).toEqual(['open-settings']);
    expect(resolveStandaloneActions([attention], actions).map((action) => action.id)).toEqual(['retry']);
  });

  it('renders a referenced plugin navigation action inside the alert', () => {
    const html = renderToStaticMarkup(
      <OperatorStrategyAttention
        attention={attention}
        actions={actions}
        resolveText={(value) => value}
        onInvoke={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Setup required');
    expect(html).toContain('Open settings');
    expect(html).not.toContain('>Retry<');
  });
});
