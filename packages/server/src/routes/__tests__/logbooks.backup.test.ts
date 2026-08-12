import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole, type LogbookHealth } from '@tx5dr/contracts';

import { requireRole } from '../../auth/authPlugin.js';
import { installApiErrorHandler } from '../../server.js';

const mocks = vi.hoisted(() => {
  const health: LogbookHealth = {
    state: 'healthy',
    readable: true,
    writable: true,
    issues: [],
    updatedAt: 1_700_000_000_000,
  };
  const latest = {
    createdAt: 1_700_000_000_000,
    size: 128,
    recordCount: 2,
    opaqueRecordCount: 0,
  };
  const provider = {
    getHealth: vi.fn(() => health),
    getBackupStatus: vi.fn(),
    createBackup: vi.fn(),
    prepareBackupRestore: vi.fn(),
    restoreBackup: vi.fn(),
    openBackupDownload: vi.fn(),
    retryOpen: vi.fn(),
  };
  const logBook = {
    id: 'logbook-N0CALL',
    name: 'N0CALL logbook',
    filePath: '/private/logbooks/N0CALL.adi',
    storageKind: 'managed' as const,
    provider,
    createdAt: 1_699_999_999_000,
    lastUsed: 1_700_000_000_000,
    isActive: true,
  };
  const getOrCreateLogBookByCallsign = vi.fn();
  const logManager = {
    resolveLogBookId: vi.fn((id: string) => id === logBook.id || id === 'N0CALL' ? logBook.id : null),
    getLogBook: vi.fn((id: string) => id === logBook.id ? logBook : null),
    getOperatorIdsForLogBook: vi.fn(() => ['operator-owner']),
    getCallsignsForLogBook: vi.fn(() => ['N0CALL']),
    getOrCreateLogBookByCallsign,
  };
  const operatorManager = {
    getLogManager: () => logManager,
    listUnsavedQsos: vi.fn(() => []),
    retryUnsavedQso: vi.fn(),
    discardUnsavedQso: vi.fn(),
  };
  const authState = {
    enabled: true,
    valid: true,
    currentRole: 'admin',
  };
  const authManager = {
    isAuthEnabled: () => authState.enabled,
    isTokenStillValid: () => authState.valid,
    getTokenCurrentPermissions: () => authState.valid
      ? { role: authState.currentRole, operatorIds: [] }
      : null,
  };
  return {
    authManager,
    authState,
    getOrCreateLogBookByCallsign,
    health,
    latest,
    logBook,
    logManager,
    operatorManager,
    provider,
  };
});

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({ operatorManager: mocks.operatorManager }),
  },
}));

vi.mock('../../auth/AuthManager.js', () => ({
  AuthManager: {
    getInstance: () => mocks.authManager,
    hasMinRole: (actual: UserRole, required: UserRole) => {
      const level = { viewer: 0, operator: 1, admin: 2 };
      return level[actual] >= level[required];
    },
  },
}));

function backupStatus(admin: boolean, unsaved?: unknown[]) {
  return {
    logBookId: mocks.logBook.id,
    revision: 'revision-1',
    mainHealth: mocks.health,
    dirty: false,
    pendingMutations: 0,
    latest: mocks.latest,
    unsaved,
    capabilities: {
      canCreate: true,
      canDownload: true,
      canRestore: admin,
      canDownloadPreRestore: admin,
    },
  };
}

const preflight = {
  preflightToken: 'preflight-token-1',
  expiresAt: 1_700_000_600_000,
  revision: 'revision-1',
  main: {
    size: 256,
    recordCount: 3,
    opaqueRecordCount: 0,
    incompleteTail: false,
    issueCount: 0,
  },
  backup: {
    size: 128,
    recordCount: 2,
    opaqueRecordCount: 0,
    incompleteTail: false,
    issueCount: 0,
  },
  recordDelta: -1,
  estimatedLoss: 1,
  highRisk: true,
};

describe('logbook backup and recovery routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.authState.enabled = true;
    mocks.authState.valid = true;
    mocks.authState.currentRole = UserRole.ADMIN;
    mocks.getOrCreateLogBookByCallsign.mockReset();
    mocks.provider.getBackupStatus.mockReset().mockImplementation(async ({ admin, unsaved }) => (
      backupStatus(admin, unsaved)
    ));
    mocks.provider.createBackup.mockReset().mockResolvedValue(backupStatus(false));
    mocks.provider.prepareBackupRestore.mockReset().mockResolvedValue(preflight);
    mocks.provider.restoreBackup.mockReset().mockImplementation(async (input) => {
      await input.beforeReplace?.();
      return backupStatus(true);
    });
    mocks.provider.openBackupDownload.mockReset();
    mocks.provider.retryOpen.mockReset().mockResolvedValue(mocks.health);
    mocks.operatorManager.listUnsavedQsos.mockReset().mockReturnValue([]);
    mocks.operatorManager.retryUnsavedQso.mockReset().mockResolvedValue({
      id: 'qso-1',
      callsign: 'K1ABC',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: 1_700_000_000_000,
      messageHistory: [],
    });
    mocks.operatorManager.discardUnsavedQso.mockReset();

    const { logbookRoutes } = await import('../logbooks.js');
    app = Fastify({ logger: false });
    installApiErrorHandler(app);
    app.decorateRequest('authUser', null);
    app.decorateRequest('ability', undefined);
    app.decorateRequest('logBookInstance', undefined);
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const requestedRole = request.headers['x-test-role'];
      const role = requestedRole === UserRole.VIEWER
        ? UserRole.VIEWER
        : requestedRole === UserRole.OPERATOR
          ? UserRole.OPERATOR
          : UserRole.ADMIN;
      request.authUser = {
        tokenId: mocks.authState.enabled ? `token-${role}` : '__local__',
        role,
        operatorIds: request.headers['x-test-owner'] === 'false' ? ['operator-other'] : ['operator-owner'],
        iat: 0,
        exp: Number.MAX_SAFE_INTEGER,
      };
    });
    await app.register(async (scope: FastifyInstance) => {
      scope.addHook('onRequest', requireRole(UserRole.OPERATOR));
      await scope.register(logbookRoutes, { prefix: '/api/logbooks' });
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns role-redacted status to an owner and rejects viewers and non-owners', async () => {
    const owner = await app.inject({
      method: 'GET',
      url: `/api/logbooks/${mocks.logBook.id}/backup`,
      headers: { 'x-test-role': UserRole.OPERATOR },
    });
    const nonOwner = await app.inject({
      method: 'GET',
      url: `/api/logbooks/${mocks.logBook.id}/backup`,
      headers: { 'x-test-role': UserRole.OPERATOR, 'x-test-owner': 'false' },
    });
    const viewer = await app.inject({
      method: 'GET',
      url: `/api/logbooks/${mocks.logBook.id}/backup`,
      headers: { 'x-test-role': UserRole.VIEWER },
    });

    expect(owner.statusCode).toBe(200);
    expect(owner.json().data.capabilities.canRestore).toBe(false);
    expect(nonOwner.statusCode).toBe(404);
    expect(viewer.statusCode).toBe(403);
  });

  it('never creates a logbook for unknown IDs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/logbooks/logbook-UNKNOWN/backup' });
    expect(response.statusCode).toBe(404);
    expect(mocks.getOrCreateLogBookByCallsign).not.toHaveBeenCalled();
  });

  it('requires only an idempotency key to create a backup and replays failures', async () => {
    const missingHeader = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/backup`,
      payload: {},
    });
    expect(missingHeader.statusCode).toBe(428);

    mocks.provider.createBackup.mockRejectedValueOnce(Object.assign(new Error('disk full'), {
      code: 'LOGBOOK_BACKUP_FAILED',
      cause: Object.assign(new Error('no space'), { code: 'ENOSPC' }),
    }));
    const request = {
      method: 'POST' as const,
      url: `/api/logbooks/${mocks.logBook.id}/backup`,
      headers: { 'Idempotency-Key': 'backup-failure-key-1' },
      payload: {},
    };
    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(507);
    expect(second.statusCode).toBe(507);
    expect(mocks.provider.createBackup).toHaveBeenCalledOnce();
  });

  it('rejects path-bearing backup request fields as a client error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/backup`,
      headers: { 'Idempotency-Key': 'backup-invalid-body-1' },
      payload: { filePath: '/private/logbooks/another.adi' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(response.body).not.toContain('/private/logbooks');
    expect(mocks.provider.createBackup).not.toHaveBeenCalled();
  });

  it('streams backup bytes from the opened artifact with hardened response headers', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.provider.openBackupDownload.mockResolvedValue({
      stream: Readable.from([Buffer.from('raw adif bytes')]),
      fileName: 'N0CALL-backup.adi',
      size: 14,
      close,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/logbooks/${mocks.logBook.id}/backup/download`,
      headers: { 'x-test-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.toString()).toBe('raw adif bytes');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('attachment; filename="N0CALL-backup.adi"');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the fixed download handle and audits failure when the stream aborts', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const audit = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.provider.openBackupDownload.mockResolvedValue({
      stream: new Readable({
        read() {
          this.destroy(new Error('download failed at /private/logbooks/N0CALL.adi'));
        },
      }),
      fileName: 'N0CALL-backup.adi',
      size: 64,
      close,
    });

    await app.inject({
      method: 'GET',
      url: `/api/logbooks/${mocks.logBook.id}/backup/download`,
      headers: { 'x-test-role': UserRole.OPERATOR },
    }).catch(() => undefined);

    expect(close).toHaveBeenCalledOnce();
    expect(audit.mock.calls.some(([, details]) => (
      typeof details === 'object'
      && details !== null
      && (details as { operation?: string }).operation === 'backup-download'
      && (details as { outcome?: string }).outcome === 'failed'
      && (details as { errorCode?: string }).errorCode === 'LOGBOOK_BACKUP_FAILED'
    ))).toBe(true);
    expect(audit.mock.calls.some(([, details]) => (
      typeof details === 'object'
      && details !== null
      && (details as { operation?: string }).operation === 'backup-download'
      && (details as { outcome?: string }).outcome === 'succeeded'
    ))).toBe(false);
    audit.mockRestore();
  });

  it('maps changed backups to conflict and redacts internal recovery errors', async () => {
    mocks.provider.prepareBackupRestore.mockRejectedValueOnce(Object.assign(
      new Error("backup changed at /private/logbooks/.tx5dr-backups/N0CALL/latest.adi with secret-jwt-token"),
      { code: 'LOGBOOK_BACKUP_CHANGED' },
    ));
    const changed = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/backup/restore/prepare`,
      headers: {
        'If-Match': 'revision-1',
        'Idempotency-Key': 'backup-changed-key-1',
      },
      payload: {},
    });

    expect(changed.statusCode).toBe(409);
    expect(changed.body).not.toContain('/private/logbooks');
    expect(changed.body).not.toContain('secret-jwt-token');
    expect(changed.json().error.message).toContain('backup changed');

    mocks.provider.getBackupStatus.mockResolvedValueOnce({
      ...backupStatus(false),
      mainHealth: {
        ...mocks.health,
        state: 'degraded',
        issues: [{
          code: 'MAIN_SCAN_FAILED',
          message: "EACCES at /private/logbooks/N0CALL.adi with secret-health-token",
          affectedBytes: 128,
          occurredAt: 1_700_000_000_000,
        }],
      },
      error: {
        code: 'LOGBOOK_BACKUP_FAILED',
        message: "EACCES: '/private/logbooks/N0CALL.adi' contained <ADIF secret>",
      },
    });
    const status = await app.inject({
      method: 'GET',
      url: `/api/logbooks/${mocks.logBook.id}/backup`,
      headers: { 'x-test-role': UserRole.OPERATOR },
    });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain('/private/logbooks');
    expect(status.body).not.toContain('<ADIF secret>');
    expect(status.body).not.toContain('secret-health-token');
    expect(status.json().data.mainHealth.issues[0]).toMatchObject({
      code: 'MAIN_SCAN_FAILED',
      affectedBytes: 128,
      message: 'The formal ADIF file could not be read safely.',
    });
  });

  it('limits prepare and restore to admins and enforces conditional revisions', async () => {
    const operator = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/backup/restore/prepare`,
      headers: {
        'x-test-role': UserRole.OPERATOR,
        'If-Match': 'revision-1',
        'Idempotency-Key': 'restore-operator-1',
      },
      payload: {},
    });
    expect(operator.statusCode).toBe(403);
    expect(mocks.provider.prepareBackupRestore).not.toHaveBeenCalled();

    mocks.provider.prepareBackupRestore.mockRejectedValueOnce(Object.assign(
      new Error('stale revision'),
      { code: 'LOGBOOK_REVISION_MISMATCH' },
    ));
    const stale = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/backup/restore/prepare`,
      headers: {
        'If-Match': 'revision-stale',
        'Idempotency-Key': 'restore-stale-key-1',
      },
      payload: {},
    });
    expect(stale.statusCode).toBe(412);
  });

  it.each([
    ['/backup/restore/prepare', {}, {}],
    ['/backup/restore/prepare', { 'If-Match': 'revision-1' }, {}],
    ['/backup/restore/prepare', { 'Idempotency-Key': 'prepare-header-key-1' }, {}],
    ['/backup/restore', {}, { preflightToken: 'preflight-token-1', confirmation: mocks.logBook.id }],
    ['/backup/restore', { 'If-Match': 'revision-1' }, { preflightToken: 'preflight-token-1', confirmation: mocks.logBook.id }],
    ['/backup/restore', { 'Idempotency-Key': 'restore-header-key-1' }, { preflightToken: 'preflight-token-1', confirmation: mocks.logBook.id }],
  ])('rejects %s before provider work when conditional headers are incomplete', async (suffix, headers, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}${suffix}`,
      headers,
      payload,
    });

    expect(response.statusCode).toBe(428);
    expect(mocks.provider.prepareBackupRestore).not.toHaveBeenCalled();
    expect(mocks.provider.restoreBackup).not.toHaveBeenCalled();
  });

  it('rechecks live administrator authorization immediately before replace', async () => {
    mocks.provider.restoreBackup.mockImplementationOnce(async (input) => {
      mocks.authState.currentRole = UserRole.OPERATOR;
      await input.beforeReplace?.();
      return backupStatus(true);
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/backup/restore`,
      headers: {
        'If-Match': 'revision-1',
        'Idempotency-Key': 'restore-downgrade-key-1',
      },
      payload: { preflightToken: 'preflight-token-1', confirmation: mocks.logBook.id },
    });

    expect(response.statusCode).toBe(401);
  });

  it('treats authentication-disabled local mode as administrator', async () => {
    mocks.authState.enabled = false;
    const response = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/backup/restore`,
      headers: {
        'If-Match': 'revision-1',
        'Idempotency-Key': 'restore-local-key-1',
      },
      payload: { preflightToken: 'preflight-token-1', confirmation: 'N0CALL' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.provider.restoreBackup).toHaveBeenCalledOnce();
  });

  it('requires an exact case-sensitive logbook ID or callsign confirmation', async () => {
    for (const [confirmation, key] of [
      ['n0call', 'restore-confirm-lower-1'],
      ['N0CALL/P', 'restore-confirm-portable-1'],
      ['N0CALL ', 'restore-confirm-space-1'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/logbooks/${mocks.logBook.id}/backup/restore`,
        headers: {
          'If-Match': 'revision-1',
          'Idempotency-Key': key,
        },
        payload: { preflightToken: 'preflight-token-1', confirmation },
      });
      expect(response.statusCode).toBe(412);
    }
    expect(mocks.provider.restoreBackup).not.toHaveBeenCalled();
  });

  it('allows only the owning operator or an admin to resolve an unsaved QSO', async () => {
    const owner = await app.inject({
      method: 'POST',
      url: `/api/logbooks/${mocks.logBook.id}/unsaved-qsos/attempt-1/retry`,
      headers: {
        'x-test-role': UserRole.OPERATOR,
        'Idempotency-Key': 'unsaved-owner-key-1',
      },
    });
    expect(owner.statusCode).toBe(200);
    expect(mocks.operatorManager.retryUnsavedQso).toHaveBeenCalledWith(
      mocks.logBook.id,
      'attempt-1',
      new Set(['operator-owner']),
    );

    const nonOwner = await app.inject({
      method: 'DELETE',
      url: `/api/logbooks/${mocks.logBook.id}/unsaved-qsos/attempt-1`,
      headers: { 'x-test-role': UserRole.OPERATOR, 'x-test-owner': 'false' },
    });
    expect(nonOwner.statusCode).toBe(404);

    const admin = await app.inject({
      method: 'DELETE',
      url: `/api/logbooks/${mocks.logBook.id}/unsaved-qsos/attempt-1`,
    });
    expect(admin.statusCode).toBe(200);
    expect(mocks.operatorManager.discardUnsavedQso).toHaveBeenCalledWith(
      mocks.logBook.id,
      'attempt-1',
      undefined,
    );
  });
});
