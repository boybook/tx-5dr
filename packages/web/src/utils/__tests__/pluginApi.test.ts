import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginApi } from '../pluginApi';

function mockWindow() {
  vi.stubGlobal('window', { __TX5DR_API_BASE__: '/api' });
}

describe('pluginApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not send JSON content-type for empty POST requests', async () => {
    mockWindow();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, operatorId: 'operator-1', pausedPlugins: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await pluginApi.pauseOperatorTransmitControlPlugins('operator-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/operators/operator-1/transmit-control/pause-all', {
      method: 'POST',
      headers: {},
    });
  });

  it('keeps JSON content-type when a request has a body', async () => {
    mockWindow();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await pluginApi.updateOperatorSettings('scheduled-cq-autocall', 'operator-1', { enabled: true });

    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/scheduled-cq-autocall/operator/operator-1/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: { enabled: true } }),
      headers: { 'content-type': 'application/json' },
    });
  });

  it('includes structured API error details in thrown errors', async () => {
    mockWindow();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        success: false,
        error: { message: 'Body cannot be empty when content-type is set to application/json' },
      }),
      { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pluginApi.pauseOperatorTransmitControlPlugins('operator-1')).rejects.toThrow(
      'Plugin API error: 400 Bad Request - Body cannot be empty when content-type is set to application/json',
    );
  });
});
