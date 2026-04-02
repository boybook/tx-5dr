import { randomUUID, createHash, X509Certificate } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import forge from 'node-forge';
import type { LoTWCertificateStatus, LoTWCertificateSummary } from '@tx5dr/contracts';
import { getConfigFilePath } from '../utils/app-paths.js';

const LOTW_CALLSIGN_OID = '1.3.6.1.4.1.12348.1.1';
const LOTW_QSO_START_OID = '1.3.6.1.4.1.12348.1.2';
const LOTW_QSO_END_OID = '1.3.6.1.4.1.12348.1.3';
const LOTW_DXCC_OID = '1.3.6.1.4.1.12348.1.4';

interface StoredCertificateFile {
  id: string;
  callsign: string;
  dxccId: number;
  serial: string;
  validFrom: number;
  validTo: number;
  qsoStartDate: number;
  qsoEndDate: number;
  fingerprint: string;
  certPem: string;
  privateKeyPem: string;
}

export interface StoredLoTWCertificate extends StoredCertificateFile {
  status: LoTWCertificateStatus;
}

interface CertificateAttribute {
  name?: string;
  shortName?: string;
  type?: string;
  value?: string | unknown[];
}

function toMillis(dateLike: string): number {
  return new Date(dateLike).getTime();
}

function toEndOfDayMillis(dateLike: string): number {
  return new Date(`${dateLike}T23:59:59.000Z`).getTime();
}

function normalizeCallsign(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeForgeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\0/g, '').trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForgeValue(item)).join('').trim();
  }
  return '';
}

function inferStatus(validFrom: number, validTo: number): LoTWCertificateStatus {
  const now = Date.now();
  if (now < validFrom) {
    return 'not_yet_valid';
  }
  if (now > validTo) {
    return 'expired';
  }
  return 'valid';
}

export class LoTWCertificateStore {
  private async getCertificatesDir(): Promise<string> {
    const filePath = await getConfigFilePath(path.join('lotw', 'certificates', '.keep'));
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    return dirPath;
  }

  private async getCertificatePath(certId: string): Promise<string> {
    const dirPath = await this.getCertificatesDir();
    return path.join(dirPath, `${certId}.json`);
  }

  async importCertificate(fileBuffer: Buffer): Promise<StoredLoTWCertificate> {
    let p12: forge.pkcs12.Pkcs12Pfx;

    try {
      const der = forge.util.createBuffer(fileBuffer.toString('binary'));
      const asn1 = forge.asn1.fromDer(der);
      p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, '');
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('mac could not be verified') || message.includes('invalid password') || message.includes('password')) {
        throw new Error('certificate_password_protected');
      }
      throw new Error('certificate_invalid');
    }

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
    ];

    const cert = certBags[0]?.cert;
    const privateKey = keyBags[0]?.key;

    if (!cert || !privateKey) {
      throw new Error('certificate_invalid');
    }

    const certPem = forge.pki.certificateToPem(cert);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
    const x509 = new X509Certificate(certPem);
    const subjectAttrs = (cert.subject.attributes || []) as CertificateAttribute[];
    const extMap = new Map((cert.extensions || []).map((ext) => [ext.id, normalizeForgeValue(ext.value)]));

    const callsign = this.extractCallsign(subjectAttrs, x509.subject);
    const dxccId = Number.parseInt(extMap.get(LOTW_DXCC_OID) || '', 10);
    const qsoStartDate = extMap.get(LOTW_QSO_START_OID) || '';
    const qsoEndDate = extMap.get(LOTW_QSO_END_OID) || '';

    if (!callsign || !Number.isFinite(dxccId) || !qsoStartDate || !qsoEndDate) {
      throw new Error('certificate_invalid');
    }

    const id = randomUUID();
    const stored: StoredCertificateFile = {
      id,
      callsign,
      dxccId,
      serial: x509.serialNumber || 'unknown',
      validFrom: toMillis(x509.validFrom),
      validTo: toMillis(x509.validTo),
      qsoStartDate: toMillis(`${qsoStartDate}T00:00:00.000Z`),
      qsoEndDate: toEndOfDayMillis(qsoEndDate),
      fingerprint: createHash('sha256').update(x509.raw).digest('hex').toUpperCase(),
      certPem,
      privateKeyPem,
    };

    const filePath = await this.getCertificatePath(id);
    await fs.writeFile(filePath, JSON.stringify(stored, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(filePath, 0o600).catch(() => {});

    return {
      ...stored,
      status: inferStatus(stored.validFrom, stored.validTo),
    };
  }

  async readCertificate(certId: string): Promise<StoredLoTWCertificate> {
    const filePath = await this.getCertificatePath(certId);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredCertificateFile;
    return {
      ...parsed,
      status: inferStatus(parsed.validFrom, parsed.validTo),
    };
  }

  async deleteCertificate(certId: string): Promise<void> {
    const filePath = await this.getCertificatePath(certId);
    await fs.unlink(filePath);
  }

  toSummary(certificate: StoredLoTWCertificate): LoTWCertificateSummary {
    return {
      id: certificate.id,
      callsign: certificate.callsign,
      dxccId: certificate.dxccId,
      serial: certificate.serial,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      qsoStartDate: certificate.qsoStartDate,
      qsoEndDate: certificate.qsoEndDate,
      fingerprint: certificate.fingerprint,
      status: certificate.status,
    };
  }

  private extractCallsign(
    attributes: CertificateAttribute[],
    subjectText: string
  ): string {
    const preferred = attributes.find((attr) => attr.type === LOTW_CALLSIGN_OID && normalizeForgeValue(attr.value));
    const preferredValue = normalizeForgeValue(preferred?.value);
    if (preferredValue) {
      return normalizeCallsign(preferredValue);
    }

    const unknown = attributes.find((attr) => normalizeForgeValue(attr.value) && attr.name === undefined && attr.type?.startsWith('1.3.6.1.4.1.12348.'));
    const unknownValue = normalizeForgeValue(unknown?.value);
    if (unknownValue) {
      return normalizeCallsign(unknownValue);
    }

    const candidate = attributes.find((attr) => {
      const value = normalizeForgeValue(attr.value);
      return value && /^[A-Z0-9/]{3,20}$/i.test(value);
    });
    const candidateValue = normalizeForgeValue(candidate?.value);
    if (candidateValue) {
      return normalizeCallsign(candidateValue);
    }

    const match = subjectText.match(/(?:^|,|\s)(?:CN=)?([A-Z0-9/]{3,20})(?:,|$)/i);
    if (match?.[1]) {
      return normalizeCallsign(match[1]);
    }

    return '';
  }
}
