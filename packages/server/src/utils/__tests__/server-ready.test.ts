import { describe, expect, it } from 'vitest';
import { createServerReadyState, resolveServerPortOptions } from '../server-ready.js';

describe('server ready helpers', () => {
  it('auto-negotiates when PORT is not explicit', () => {
    expect(resolveServerPortOptions({} as NodeJS.ProcessEnv)).toMatchObject({
      requestedPort: 4000,
      autoPort: true,
      scanSteps: 50,
    });
  });

  it('keeps explicit PORT strict by default', () => {
    expect(resolveServerPortOptions({ PORT: '4100' } as NodeJS.ProcessEnv)).toMatchObject({
      requestedPort: 4100,
      autoPort: false,
    });
  });

  it('allows explicit opt-in auto negotiation for embedded launchers', () => {
    expect(resolveServerPortOptions({
      PORT: '4100',
      TX5DR_SERVER_PORT_AUTO: '1',
      TX5DR_SERVER_PORT_SCAN_STEPS: '3',
    } as NodeJS.ProcessEnv)).toMatchObject({
      requestedPort: 4100,
      autoPort: true,
      scanSteps: 3,
    });
  });

  it('lets strict mode override auto negotiation', () => {
    expect(resolveServerPortOptions({
      TX5DR_SERVER_PORT_AUTO: '1',
      TX5DR_SERVER_PORT_STRICT: '1',
    } as NodeJS.ProcessEnv)).toMatchObject({
      requestedPort: 4000,
      autoPort: false,
    });
  });

  it('creates a ready state with the negotiated base URL', () => {
    expect(createServerReadyState({
      requestedPort: 4000,
      httpPort: 4001,
      autoPort: true,
    })).toMatchObject({
      requestedPort: 4000,
      httpPort: 4001,
      baseUrl: 'http://127.0.0.1:4001',
      healthOk: true,
      autoPort: true,
      error: null,
    });
  });
});
