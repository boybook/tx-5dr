import { describe, expect, it } from 'vitest';

import { getOperatorPanelContainerClass } from '../OperatorPluginPanels';

describe('OperatorPluginPanels', () => {
  it('uses full-row span for panels that request full width', () => {
    expect(getOperatorPanelContainerClass({
      id: 'panel-1',
      title: 'demo',
      component: 'iframe',
      width: 'full',
    })).toBe('md:col-span-2');
  });

  it('keeps default half-width layout for panels without an explicit width', () => {
    expect(getOperatorPanelContainerClass({
      id: 'panel-2',
      title: 'demo',
      component: 'key-value',
    })).toBe('');
  });
});
