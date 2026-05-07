import { createHash, randomBytes } from 'crypto';
import { hostname } from 'os';
import { promises as fs } from 'fs';
import { getConfigFilePath } from '../utils/app-paths.js';

export const DEVICE_UI_AUDIENCE = 'tx5dr-device-ui' as const;
export const DEVICE_UI_SCOPE = 'device-ui' as const;
export const DEVICE_UI_JWT_TTL_SECONDS = 3600;

export interface DeviceTokenRecord {
  token: string;
  createdAt: number;
}

export class DeviceServiceAuth {
  private static instance: DeviceServiceAuth | null = null;
  private tokenPath: string | null = null;
  private cachedRecord: DeviceTokenRecord | null = null;

  static getInstance(): DeviceServiceAuth {
    if (!DeviceServiceAuth.instance) {
      DeviceServiceAuth.instance = new DeviceServiceAuth();
    }
    return DeviceServiceAuth.instance;
  }

  async getTokenPath(): Promise<string> {
    if (!this.tokenPath) {
      this.tokenPath = await getConfigFilePath('.device-ui-token');
    }
    return this.tokenPath;
  }

  async ensureToken(): Promise<DeviceTokenRecord> {
    if (this.cachedRecord) return this.cachedRecord;

    const tokenPath = await this.getTokenPath();
    try {
      const existing = (await fs.readFile(tokenPath, 'utf-8')).trim();
      if (existing.length >= 16) {
        this.cachedRecord = { token: existing, createdAt: 0 };
        return this.cachedRecord;
      }
    } catch {
      // Create below.
    }

    const record = {
      token: `tx5dr_device_${randomBytes(32).toString('base64url')}`,
      createdAt: Date.now(),
    };
    await fs.writeFile(tokenPath, `${record.token}\n`, { encoding: 'utf-8', mode: 0o600 });
    this.cachedRecord = record;
    return record;
  }

  async verifyToken(token: string): Promise<boolean> {
    const record = await this.ensureToken();
    return record.token === token;
  }

  async getDeviceId(): Promise<string> {
    try {
      const machineId = (await fs.readFile('/etc/machine-id', 'utf-8')).trim();
      if (machineId) return createHash('sha256').update(machineId).digest('hex').slice(0, 12);
    } catch {
      // Fall through to deterministic local fallback.
    }

    const tokenPath = await this.getTokenPath();
    return createHash('sha256').update(`${hostname()}:${tokenPath}`).digest('hex').slice(0, 12);
  }
}
