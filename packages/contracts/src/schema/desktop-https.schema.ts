import { z } from 'zod';

export const DesktopHttpsModeSchema = z.enum(['self-signed', 'imported-pem']);
export type DesktopHttpsMode = z.infer<typeof DesktopHttpsModeSchema>;

export const DesktopHttpsCertificateStatusSchema = z.enum(['missing', 'valid', 'invalid']);
export type DesktopHttpsCertificateStatus = z.infer<typeof DesktopHttpsCertificateStatusSchema>;

export const DesktopHttpsAccessSchemeSchema = z.enum(['http', 'https']);
export type DesktopHttpsAccessScheme = z.infer<typeof DesktopHttpsAccessSchemeSchema>;

export const DesktopHttpsCertificateMetaSchema = z.object({
  source: DesktopHttpsModeSchema,
  subject: z.string().nullable(),
  issuer: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  fingerprintSha256: z.string().nullable(),
  altNames: z.array(z.string()).default([]),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type DesktopHttpsCertificateMeta = z.infer<typeof DesktopHttpsCertificateMetaSchema>;

export const DesktopHttpsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: DesktopHttpsModeSchema.default('self-signed'),
  httpsPort: z.number().int().min(1).max(65535).default(8443),
  redirectExternalHttp: z.boolean().default(true),
});
export type DesktopHttpsSettings = z.infer<typeof DesktopHttpsSettingsSchema>;

export const DesktopHttpsStatusSchema = DesktopHttpsSettingsSchema.extend({
  activeScheme: DesktopHttpsAccessSchemeSchema.default('http'),
  activePort: z.number().int().min(1).max(65535),
  httpPort: z.number().int().min(1).max(65535),
  effectiveHttpsPort: z.number().int().min(1).max(65535).nullable().default(null),
  browserAccessUrl: z.string().nullable(),
  shareUrls: z.array(z.string()).default([]),
  certificateStatus: DesktopHttpsCertificateStatusSchema.default('missing'),
  certificateMeta: DesktopHttpsCertificateMetaSchema.nullable(),
  usingSelfSigned: z.boolean().default(false),
  needsCertificate: z.boolean().default(true),
});
export type DesktopHttpsStatus = z.infer<typeof DesktopHttpsStatusSchema>;
