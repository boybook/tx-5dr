// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AnimatedLogbookGlobe from './AnimatedLogbookGlobe';

afterEach(cleanup);

describe('AnimatedLogbookGlobe', () => {
  it('collapses without remounting the globe and expands it on return', async () => {
    const globe = (active: boolean) => <div data-active={active}>Globe canvas</div>;
    const view = render(<AnimatedLogbookGlobe visible>{globe}</AnimatedLogbookGlobe>);
    const canvas = screen.getByText('Globe canvas');
    expect(canvas.getAttribute('data-active')).toBe('true');

    view.rerender(<AnimatedLogbookGlobe visible={false}>{globe}</AnimatedLogbookGlobe>);
    expect(view.container.querySelector('[data-logbook-globe-transition]')?.getAttribute('data-logbook-globe-transition'))
      .toBe('collapsed');
    expect(screen.getByText('Globe canvas')).toBe(canvas);
    expect(canvas.getAttribute('data-active')).toBe('false');

    view.rerender(<AnimatedLogbookGlobe visible>{globe}</AnimatedLogbookGlobe>);
    expect(screen.getByText('Globe canvas')).toBe(canvas);
    expect(view.container.querySelector('[data-logbook-globe-transition]')?.getAttribute('data-logbook-globe-transition'))
      .toBe('collapsed');
    await waitFor(() => expect(view.container.querySelector('[data-logbook-globe-transition]')
      ?.getAttribute('data-logbook-globe-transition')).toBe('expanded'));
    expect(canvas.getAttribute('data-active')).toBe('false');
    const container = view.container.querySelector('[data-logbook-globe-transition]')!;
    const transitionEnd = (propertyName: string) => {
      const event = new Event('transitionend', { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: propertyName });
      fireEvent(container, event);
    };
    transitionEnd('opacity');
    expect(canvas.getAttribute('data-active')).toBe('false');
    transitionEnd('grid-template-rows');
    expect(canvas.getAttribute('data-active')).toBe('true');
  });

  it('resumes drawing if a browser omits transitionend', async () => {
    const globe = (active: boolean) => <div data-active={active}>Globe canvas</div>;
    const view = render(<AnimatedLogbookGlobe visible>{globe}</AnimatedLogbookGlobe>);
    view.rerender(<AnimatedLogbookGlobe visible={false}>{globe}</AnimatedLogbookGlobe>);
    view.rerender(<AnimatedLogbookGlobe visible>{globe}</AnimatedLogbookGlobe>);

    await waitFor(() => expect(screen.getByText('Globe canvas').getAttribute('data-active')).toBe('true'), {
      timeout: 1_500,
    });
  });
});
