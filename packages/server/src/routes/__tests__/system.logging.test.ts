import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';
import { buildAbility } from '../../auth/ability.js';
import { getActiveLogLevel, setLogLevel } from '../../utils/logger.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const mockConfig = vi.hoisted(() => ({
  current: { logLevel: 'info' as LogLevel },
  updateLogLevel: vi.fn(async (level: LogLevel) => {
    mockConfig.current.logLevel = level;
  }),
}));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getNtpCalibrationService: () => ({
        getStatus: vi.fn(),
        setAppliedOffset: vi.fn(),
        triggerMeasurement: vi.fn(),
        setAutoApplyOffset: vi.fn(),
        setServers: vi.fn(),
      }),
    }),
  },
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getConfig: () => ({ ...mockConfig.current }),
      updateLogLevel: mockConfig.updateLogLevel,
      getNtpServers: () => ['pool.ntp.org'],
      getDefaultNtpServers: () => ['pool.ntp.org'],
      updateNtpAutoApplyOffset: vi.fn(),
      updateNtpServers: vi.fn(),
    }),
  },
}));

vi.mock('../../utils/app-paths.js', () => ({
  tx5drPaths: {
    getLogsDir: vi.fn(async () => '/tmp/tx5dr-logs'),
  },
}));

describe('system logging routes', () => {
  let fastify: ReturnType<typeof Fastify>;
  const previousEnvLogLevel = process.env.LOG_LEVEL;

  beforeEach(async () => {
    mockConfig.current.logLevel = 'info';
    mockConfig.updateLogLevel.mockClear();
    setLogLevel('info');
    process.env.LOG_LEVEL = 'info';

    const { systemRoutes } = await import('../system.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.decorateRequest('ability', undefined);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const role = (request.headers['x-role'] as UserRole | undefined) ?? UserRole.ADMIN;
      request.authUser = {
        tokenId: 'test-token',
        role,
        operatorIds: [],
        iat: 0,
        exp: 0,
      };
      request.ability = buildAbility({ role });
    });
    await fastify.register(systemRoutes, { prefix: '/api/system' });
  });

  afterEach(async () => {
    await fastify.close();
    setLogLevel('info');
    if (previousEnvLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previousEnvLogLevel;
    }
  });

  it('returns configured level, active level, and backend logs directory', async () => {
    mockConfig.current.logLevel = 'warn';
    setLogLevel('warn');

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/system/logging',
      headers: { 'x-role': UserRole.ADMIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      level: 'warn',
      effectiveLevel: 'warn',
      logsDir: '/tmp/tx5dr-logs',
    });
  });

  it('rejects invalid log levels before mutating runtime state', async () => {
    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/system/logging',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { level: 'trace' },
    });

    expect(response.statusCode).toBe(400);
    expect(mockConfig.updateLogLevel).not.toHaveBeenCalled();
    expect(getActiveLogLevel()).toBe('info');
    expect(process.env.LOG_LEVEL).toBe('info');
  });

  it.each(['debug', 'warn', 'error'] as const)('persists and applies %s without restart', async (level) => {
    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/system/logging',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { level },
    });

    expect(response.statusCode).toBe(200);
    expect(mockConfig.updateLogLevel).toHaveBeenCalledWith(level);
    expect(getActiveLogLevel()).toBe(level);
    expect(process.env.LOG_LEVEL).toBe(level);
    expect(response.json()).toEqual({
      level,
      effectiveLevel: level,
      logsDir: '/tmp/tx5dr-logs',
    });
  });

  it('requires manage all permission for viewers', async () => {
    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/system/logging',
      headers: { 'x-role': UserRole.VIEWER },
      payload: { level: 'debug' },
    });

    expect(response.statusCode).toBe(403);
    expect(mockConfig.updateLogLevel).not.toHaveBeenCalled();
  });
});
