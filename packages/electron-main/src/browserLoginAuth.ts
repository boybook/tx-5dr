import { registerSensitiveLogValue } from './sensitiveLog.js';

interface BackendResponse {
  statusCode: number;
  body: unknown;
}

export interface BrowserLoginAuthDependencies {
  requestJson: (
    path: string,
    options?: { method?: string; body?: unknown; authorization?: string },
  ) => Promise<BackendResponse>;
  readAdminToken: () => string | null;
  getAdminTokenVersion?: () => string | null;
}

interface AuthStatusBody {
  enabled?: boolean;
}

interface LoginBody {
  jwt?: string;
}

interface BrowserLoginCodeBody {
  code?: string;
  expiresAt?: number;
}

export class BrowserLoginAuthService {
  private cachedJwt: string | null = null;
  private cachedAdminTokenVersion: string | null = null;
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly dependencies: BrowserLoginAuthDependencies) {}

  async buildAuthenticatedUrl(baseUrl: string): Promise<string> {
    const status = await this.dependencies.requestJson('/api/auth/status');
    if (status.statusCode !== 200) throw new Error('Unable to read authentication status');
    if (!(status.body as AuthStatusBody)?.enabled) return baseUrl;

    this.invalidateJwtIfAdminTokenChanged();
    const code = await this.createCodeWithRetry();
    const url = new URL(baseUrl);
    url.hash = new URLSearchParams({ browser_login_code: code }).toString();
    return url.toString();
  }

  clearCachedJwt(): void {
    this.cachedJwt = null;
    this.cachedAdminTokenVersion = null;
  }

  private async createCodeWithRetry(): Promise<string> {
    let jwt = await this.getJwt();
    let response = await this.requestCode(jwt);

    if (response.statusCode === 401) {
      this.clearCachedJwt();
      jwt = await this.getJwt();
      response = await this.requestCode(jwt);
    }

    if (response.statusCode !== 200) {
      throw new Error(`Unable to create browser login code (HTTP ${response.statusCode})`);
    }

    const body = response.body as BrowserLoginCodeBody;
    if (!body?.code || typeof body.expiresAt !== 'number') {
      throw new Error('Browser login code response is invalid');
    }
    registerSensitiveLogValue(body.code);
    return body.code;
  }

  private async requestCode(jwt: string): Promise<BackendResponse> {
    return this.dependencies.requestJson('/api/auth/browser-login-codes', {
      method: 'POST',
      authorization: `Bearer ${jwt}`,
    });
  }

  private async getJwt(): Promise<string> {
    if (this.cachedJwt) return this.cachedJwt;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.loginWithAdminToken();
    try {
      this.cachedJwt = await this.loginInFlight;
      this.cachedAdminTokenVersion = this.dependencies.getAdminTokenVersion?.() ?? null;
      return this.cachedJwt;
    } finally {
      this.loginInFlight = null;
    }
  }

  private async loginWithAdminToken(): Promise<string> {
    const token = this.dependencies.readAdminToken();
    if (!token) throw new Error('Admin token file is unavailable');
    registerSensitiveLogValue(token);

    const response = await this.dependencies.requestJson('/api/auth/login', {
      method: 'POST',
      body: { token },
    });
    if (response.statusCode !== 200) {
      throw new Error(`Admin authentication failed (HTTP ${response.statusCode})`);
    }

    const jwt = (response.body as LoginBody)?.jwt;
    if (!jwt) throw new Error('Admin authentication response is invalid');
    registerSensitiveLogValue(jwt);
    return jwt;
  }

  private invalidateJwtIfAdminTokenChanged(): void {
    if (!this.cachedJwt || !this.dependencies.getAdminTokenVersion) return;
    const currentVersion = this.dependencies.getAdminTokenVersion();
    if (currentVersion !== this.cachedAdminTokenVersion) this.clearCachedJwt();
  }
}
