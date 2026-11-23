import React from 'react';
import { Snippet } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { DesktopCertificateSummary } from '@tx5dr/contracts';

interface CertificateDetailsProps {
  fingerprint256: string;
  certificate?: DesktopCertificateSummary | null;
  previousFingerprint256?: string | null;
}

/** Fingerprint and certificate facts the operator compares with the station. */
export const CertificateDetails: React.FC<CertificateDetailsProps> = ({ fingerprint256, certificate, previousFingerprint256 }) => {
  const { t } = useTranslation('stations');
  const rows: Array<[string, string]> = [];
  if (certificate?.subject) rows.push([t('cert.subject'), certificate.subject]);
  if (certificate?.validTo) rows.push([t('cert.validTo'), certificate.validTo]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-tiny font-medium text-default-500">{t('cert.fingerprint')}</span>
        <Snippet
          hideSymbol
          size="sm"
          variant="flat"
          codeString={fingerprint256}
          classNames={{
            base: 'w-full items-start',
            pre: 'whitespace-pre-wrap break-all font-mono text-tiny leading-5',
          }}
        >
          {fingerprint256}
        </Snippet>
      </div>
      {previousFingerprint256 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-tiny font-medium text-default-500">{t('cert.previous')}</span>
          <p className="break-all rounded-medium bg-default-100 px-3 py-2 font-mono text-tiny leading-5 text-default-400 line-through decoration-default-300">
            {previousFingerprint256}
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-small">
          {rows.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-default-500">{label}</dt>
              <dd className="min-w-0 break-words text-foreground">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
};
