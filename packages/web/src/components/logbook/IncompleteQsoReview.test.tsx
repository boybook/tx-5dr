// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IncompleteQsoReview from './IncompleteQsoReview';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), health: vi.fn(), preview: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tx5dr/core', () => ({ api: {
  getIncompleteQsoCandidates: mocks.list,
  getIncompleteQsoHealth: mocks.health,
  previewIncompleteQsos: mocks.preview,
} }));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('IncompleteQsoReview', () => {
  it('submits selected candidate identities to the batch preview', async () => {
    mocks.list.mockResolvedValue({ data: { items: [{
      id: '11111111-1111-4111-8111-111111111111', revision: 3,
      logBookId: 'logbook-W1AAA', myCallsign: 'W1AAA', callsign: 'K1BBB',
      mode: 'FT8', frequency: 14_075_000, startTime: Date.UTC(2026, 8, 25, 12),
      endTime: Date.UTC(2026, 8, 25, 12, 1), status: 'pending',
    }] } });
    mocks.health.mockResolvedValue({ data: { state: 'ready', dropped: 0 } });
    mocks.preview.mockResolvedValue({ data: { items: [] } });

    const onBack = vi.fn();
    const view = render(<IncompleteQsoReview logBookId="logbook-W1AAA" writable onBack={onBack} onRecorded={() => {}}
      onOpenQso={() => {}} />);
    expect(view.container.querySelector('section')?.className).toContain('pt-5');
    await screen.findByText('K1BBB');
    fireEvent.click(screen.getByRole('button', { name: 'review.qsoView' }));
    expect(onBack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('checkbox', { name: 'K1BBB' }));
    fireEvent.click(screen.getByRole('button', { name: 'review.preview' }));

    await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith('logbook-W1AAA', {
      items: [{ id: '11111111-1111-4111-8111-111111111111', revision: 3 }],
    }));
  });

  it('reserves the macOS Electron titlebar area for window controls', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Electron Macintosh');
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    mocks.list.mockResolvedValue({ data: { items: [] } });
    mocks.health.mockResolvedValue({ data: { state: 'ready', dropped: 0 } });

    const view = render(<IncompleteQsoReview logBookId="logbook-W1AAA" writable
      onBack={() => {}} onRecorded={() => {}} onOpenQso={() => {}} />);
    expect(view.container.querySelector('section')?.className).toContain('pt-11 md:pt-12');
    await screen.findByText('review.empty');
  });
});
