// @vitest-environment jsdom
import React, { lazy, useEffect } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModePane } from './ModePane';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('cleans up the outgoing mode before an incoming lazy view finishes loading', async () => {
  const stopOldMode = vi.fn();
  function DigitalView() {
    useEffect(() => stopOldMode, []);
    return <div>Digital view</div>;
  }
  let load!: (module: { default: React.ComponentType }) => void;
  const VoiceView = lazy(() => new Promise<{ default: React.ComponentType }>(resolve => { load = resolve; }));
  const view = render(<ModePane mode="digital"><DigitalView /></ModePane>);
  expect(screen.getByText('Digital view')).toBeTruthy();
  view.rerender(<ModePane mode="voice"><VoiceView /></ModePane>);
  expect(stopOldMode).toHaveBeenCalledOnce();
  expect(screen.queryByText('Digital view')).toBeNull();
  await act(async () => load({ default: () => <div>Voice view</div> }));
  expect(screen.getByText('Voice view')).toBeTruthy();
  expect(stopOldMode).toHaveBeenCalledOnce();
});
