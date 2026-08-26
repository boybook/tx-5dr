import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperatorTransmissionStack } from './OperatorTransmissionStack';

describe('OperatorTransmissionStack', () => {
  it('keeps a single transmission on one prominent line', () => {
    const html = renderToStaticMarkup(<OperatorTransmissionStack
      transmissions={[{ streamId: 'stream-1', text: 'JA1AAA BG5DRB PM01', audioFrequencyHz: 1_200 }]}
      fallbackText="Preparing"
      variant="header"
    />);

    expect(html).toContain('text-lg');
    expect(html).not.toContain('role="list"');
    expect(html).toContain('JA1AAA BG5DRB PM01');
  });

  it('renders every concurrent transmission as a compact vertical row', () => {
    const html = renderToStaticMarkup(<OperatorTransmissionStack
      transmissions={[
        { streamId: 'stream-1', text: 'JA1AAA BG5DRB PM01', audioFrequencyHz: 1_200 },
        { streamId: 'stream-2', text: 'JA2BBB BG5DRB R-09', audioFrequencyHz: 1_560 },
        { streamId: 'stream-3', text: 'JA3CCC BG5DRB RR73', audioFrequencyHz: 1_800 },
      ]}
      fallbackText="Preparing"
      variant="header"
    />);

    expect(html).toContain('role="list"');
    expect((html.match(/role="listitem"/g) ?? [])).toHaveLength(3);
    expect(html).toContain('text-[11px]');
    expect(html).not.toContain(' · ');
  });
});
