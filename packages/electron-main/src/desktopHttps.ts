import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPublicKey, X509Certificate, randomBytes } from 'node:crypto';
import forge from 'node-forge';
import type {
  DesktopHttpsCertificateMeta,
  DesktopHttpsMode,
  DesktopHttpsSettings,
  DesktopHttpsStatus,
} from '@tx5dr/contracts';

export interface PersistentDesktopHttpsConfig extends DesktopHttpsSettings {
  certPath: string | null;
  keyPath: string | null;
  certificateMeta: DesktopHttpsCertificateMeta | null;
}

export const DEFAULT_DESKTOP_HTTPS_CONFIG: PersistentDesktopHttpsConfig = {
  enabled: false,
  mode: 'self-signed',
  httpsPort: 8443,
  redirectExternalHttp: true,
  certPath: null,
  keyPath: null,
  certificateMeta: null,
};

const TLS_DIR_NAME = 'tls';
const SELF_SIGNED_CERT_FILE = 'desktop-selfsigned-cert.pem';
const SELF_SIGNED_KEY_FILE = 'desktop-selfsigned-key.pem';
const IMPORTED_CERT_FILE = 'desktop-imported-cert.pem';
const IMPORTED_KEY_FILE = 'desktop-imported-key.pem';

export function sanitizeDesktopHttpsConfig(
  raw?: Partial<PersistentDesktopHttpsConfig> | null,
): PersistentDesktopHttpsConfig {
  return {
    ...DEFAULT_DESKTOP_HTTPS_CONFIG,
    ...raw,
    enabled: raw?.enabled ?? DEFAULT_DESKTOP_HTTPS_CONFIG.enabled,
    mode: raw?.mode ?? DEFAULT_DESKTOP_HTTPS_CONFIG.mode,
    httpsPort: normalizePort(raw?.httpsPort, DEFAULT_DESKTOP_HTTPS_CONFIG.httpsPort),
    redirectExternalHttp: raw?.redirectExternalHttp ?? DEFAULT_DESKTOP_HTTPS_CONFIG.redirectExternalHttp,
    certPath: raw?.certPath ?? null,
    keyPath: raw?.keyPath ?? null,
    certificateMeta: raw?.certificateMeta ?? null,
  };
}

export function getTlsDir(configDir: string): string {
  return path.join(configDir, TLS_DIR_NAME);
}

export async function buildDesktopHttpsStatus(params: {
  configDir: string;
  config?: Partial<PersistentDesktopHttpsConfig> | null;
  hostname: string;
  httpPort: number;
  httpsPort?: number | null;
  lanAddresses: string[];
}): Promise<DesktopHttpsStatus> {
  const config = sanitizeDesktopHttpsConfig(params.config);

  let certificateStatus: DesktopHttpsStatus['certificateStatus'] = 'missing';
  let certificateMeta = config.certificateMeta ?? null;

  if (config.certPath && config.keyPath) {
    try {
      const [certPem, keyPem] = await Promise.all([
        fs.readFile(config.certPath, 'utf8'),
        fs.readFile(config.keyPath, 'utf8'),
      ]);
      validateCertificatePair(certPem, keyPem);
      certificateMeta = buildCertificateMeta(
        certPem,
        config.mode,
        certificateMeta?.createdAt ?? new Date().toISOString(),
        certificateMeta?.updatedAt ?? new Date().toISOString(),
      );
      certificateStatus = 'valid';
    } catch {
      certificateStatus = 'invalid';
    }
  }

  const canUseHttps = config.enabled && certificateStatus === 'valid' && Boolean(params.httpsPort);
  const effectiveScheme = canUseHttps ? 'https' : 'http';
  const effectiveHttpsPort = canUseHttps ? params.httpsPort! : null;
  const effectivePort = effectiveHttpsPort ?? params.httpPort;
  const shareUrls = buildShareUrls(effectiveScheme, effectivePort, params.hostname, params.lanAddresses);

  return {
    enabled: config.enabled,
    mode: config.mode,
    httpsPort: config.httpsPort,
    redirectExternalHttp: config.redirectExternalHttp,
    activeScheme: canUseHttps ? 'https' : 'http',
    activePort: effectivePort,
    httpPort: params.httpPort,
    effectiveHttpsPort,
    browserAccessUrl: shareUrls[0] ?? null,
    shareUrls,
    certificateStatus,
    certificateMeta,
    usingSelfSigned: certificateStatus === 'valid' && config.mode === 'self-signed',
    needsCertificate: config.enabled && certificateStatus !== 'valid',
  };
}

export async function generateSelfSignedCertificate(params: {
  configDir: string;
  hostname: string;
  lanAddresses: string[];
  existingConfig?: Partial<PersistentDesktopHttpsConfig> | null;
}): Promise<PersistentDesktopHttpsConfig> {
  const current = sanitizeDesktopHttpsConfig(params.existingConfig);
  const tlsDir = getTlsDir(params.configDir);
  await fs.mkdir(tlsDir, { recursive: true });

  const { certPem, keyPem } = createSelfSignedCertificatePem(params.hostname, params.lanAddresses);
  const certPath = path.join(tlsDir, SELF_SIGNED_CERT_FILE);
  const keyPath = path.join(tlsDir, SELF_SIGNED_KEY_FILE);
  const now = new Date().toISOString();

  await Promise.all([
    fs.writeFile(certPath, certPem, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(keyPath, keyPem, { encoding: 'utf8', mode: 0o600 }),
  ]);

  return {
    ...current,
    mode: 'self-signed',
    certPath,
    keyPath,
    certificateMeta: buildCertificateMeta(certPem, 'self-signed', current.certificateMeta?.createdAt ?? now, now),
  };
}

export async function importPemCertificate(params: {
  configDir: string;
  certPath: string;
  keyPath: string;
  existingConfig?: Partial<PersistentDesktopHttpsConfig> | null;
}): Promise<PersistentDesktopHttpsConfig> {
  const current = sanitizeDesktopHttpsConfig(params.existingConfig);
  const tlsDir = getTlsDir(params.configDir);
  await fs.mkdir(tlsDir, { recursive: true });

  const [certPem, keyPem] = await Promise.all([
    fs.readFile(params.certPath, 'utf8'),
    fs.readFile(params.keyPath, 'utf8'),
  ]);

  validateCertificatePair(certPem, keyPem);

  const targetCertPath = path.join(tlsDir, IMPORTED_CERT_FILE);
  const targetKeyPath = path.join(tlsDir, IMPORTED_KEY_FILE);
  const now = new Date().toISOString();

  await Promise.all([
    fs.writeFile(targetCertPath, certPem, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(targetKeyPath, keyPem, { encoding: 'utf8', mode: 0o600 }),
  ]);

  return {
    ...current,
    mode: 'imported-pem',
    certPath: targetCertPath,
    keyPath: targetKeyPath,
    certificateMeta: buildCertificateMeta(certPem, 'imported-pem', current.certificateMeta?.createdAt ?? now, now),
  };
}

export async function disableDesktopHttps(config?: Partial<PersistentDesktopHttpsConfig> | null): Promise<PersistentDesktopHttpsConfig> {
  return {
    ...sanitizeDesktopHttpsConfig(config),
    enabled: false,
  };
}

function normalizePort(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || !value || value < 1 || value > 65535) {
    return fallback;
  }
  return value;
}

function buildShareUrls(
  scheme: 'http' | 'https',
  port: number,
  hostname: string,
  lanAddresses: string[],
): string[] {
  const urls = new Set<string>();
  urls.add(`${scheme}://localhost:${port}`);

  if (hostname && hostname !== 'localhost') {
    urls.add(`${scheme}://${hostname}:${port}`);
  }

  for (const address of lanAddresses) {
    urls.add(`${scheme}://${address}:${port}`);
  }

  return Array.from(urls);
}

function createSelfSignedCertificatePem(hostname: string, lanAddresses: string[]): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(16).toString('hex');

  const now = new Date();
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  cert.validity.notBefore = now;
  cert.validity.notAfter = expires;

  const subject = [
    { name: 'commonName', value: hostname || 'localhost' },
    { name: 'organizationName', value: 'TX-5DR' },
  ];

  const dnsNames = new Set(['localhost']);
  if (hostname) {
    dnsNames.add(hostname);
  }

  const ipAddresses = new Set(['127.0.0.1', ...lanAddresses]);
  const altNames = [
    ...Array.from(dnsNames).map((value) => ({ type: 2, value })),
    ...Array.from(ipAddresses).map((ip) => ({ type: 7, ip })),
  ];

  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function validateCertificatePair(certPem: string, keyPem: string): void {
  const cert = new X509Certificate(certPem);
  const certPublic = cert.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyPublic = createPublicKey(keyPem).export({ type: 'spki', format: 'pem' }).toString();

  if (certPublic !== keyPublic) {
    throw new Error('certificate_key_mismatch');
  }

  const now = Date.now();
  if (now < new Date(cert.validFrom).getTime() || now > new Date(cert.validTo).getTime()) {
    throw new Error('certificate_not_valid_now');
  }
}

function buildCertificateMeta(
  certPem: string,
  source: DesktopHttpsMode,
  createdAt: string,
  updatedAt: string,
): DesktopHttpsCertificateMeta {
  const cert = new X509Certificate(certPem);
  return {
    source,
    subject: normalizeDn(cert.subject),
    issuer: normalizeDn(cert.issuer),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    fingerprintSha256: normalizeFingerprint(cert.fingerprint256),
    altNames: parseAltNames(cert.subjectAltName),
    createdAt,
    updatedAt,
  };
}

function normalizeDn(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/\n/g, ', ').trim() || null;
}

function normalizeFingerprint(value: string | undefined): string | null {
  if (!value) return null;
  return value.trim() || null;
}

function parseAltNames(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/,\s*/)
    .map((item) => item.replace(/^DNS:/, '').replace(/^IP Address:/, '').trim())
    .filter(Boolean);
}
