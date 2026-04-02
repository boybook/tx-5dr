import { z } from 'zod';

export interface LoTWLocationRule {
  stateLabel: string;
  countyLabel?: string;
  requiresState: boolean;
  requiresCounty: boolean;
}

const DEFAULT_LOCATION_RULE: LoTWLocationRule = {
  stateLabel: 'State / Province / Prefecture',
  requiresState: false,
  requiresCounty: false,
};

export const LOTW_LOCATION_RULES: Record<number, LoTWLocationRule> = {
  1: {
    stateLabel: 'Province',
    requiresState: true,
    requiresCounty: false,
  },
  5: {
    stateLabel: 'Kunta',
    requiresState: true,
    requiresCounty: false,
  },
  6: {
    stateLabel: 'State',
    countyLabel: 'County',
    requiresState: true,
    requiresCounty: false,
  },
  15: {
    stateLabel: 'Oblast',
    requiresState: true,
    requiresCounty: false,
  },
  54: {
    stateLabel: 'Oblast',
    requiresState: true,
    requiresCounty: false,
  },
  61: {
    stateLabel: 'Oblast',
    requiresState: true,
    requiresCounty: false,
  },
  110: {
    stateLabel: 'State',
    countyLabel: 'County',
    requiresState: true,
    requiresCounty: false,
  },
  125: {
    stateLabel: 'Oblast',
    requiresState: true,
    requiresCounty: false,
  },
  150: {
    stateLabel: 'State',
    requiresState: true,
    requiresCounty: false,
  },
  151: {
    stateLabel: 'Oblast',
    requiresState: true,
    requiresCounty: false,
  },
  224: {
    stateLabel: 'Kunta',
    requiresState: true,
    requiresCounty: false,
  },
  291: {
    stateLabel: 'State',
    countyLabel: 'County',
    requiresState: true,
    requiresCounty: false,
  },
  318: {
    stateLabel: 'Province',
    requiresState: true,
    requiresCounty: false,
  },
  339: {
    stateLabel: 'Prefecture',
    countyLabel: 'City / Gun / Ku',
    requiresState: true,
    requiresCounty: false,
  },
};

export function getLoTWLocationRule(dxccId?: number | null): LoTWLocationRule {
  if (!dxccId) {
    return DEFAULT_LOCATION_RULE;
  }
  return LOTW_LOCATION_RULES[dxccId] || DEFAULT_LOCATION_RULE;
}

export const LoTWCertificateStatusSchema = z.enum([
  'valid',
  'expired',
  'superseded',
  'not_yet_valid',
  'out_of_qso_range',
]);

export const LoTWCertificateSummarySchema = z.object({
  id: z.string(),
  callsign: z.string(),
  dxccId: z.number().int().positive(),
  serial: z.string(),
  validFrom: z.number(),
  validTo: z.number(),
  qsoStartDate: z.number(),
  qsoEndDate: z.number(),
  fingerprint: z.string(),
  status: LoTWCertificateStatusSchema.default('valid'),
});

export const LoTWUploadLocationSchema = z.object({
  id: z.string().optional(),
  name: z.string().default('Default Station Location'),
  callsign: z.string().default(''),
  dxccId: z.number().int().positive().optional(),
  gridSquare: z.string().default(''),
  cqZone: z.string().default(''),
  ituZone: z.string().default(''),
  iota: z.string().default(''),
  state: z.string().default(''),
  county: z.string().default(''),
  validFrom: z.number().optional(),
  validTo: z.number().optional(),
  certificateIds: z.array(z.string()).default([]),
});

const DEFAULT_UPLOAD_LOCATION: z.infer<typeof LoTWUploadLocationSchema> = {
  name: 'Default Station Location',
  callsign: '',
  gridSquare: '',
  cqZone: '',
  ituZone: '',
  iota: '',
  state: '',
  county: '',
  certificateIds: [],
};

/**
 * LoTW 配置 Schema
 */
export const LoTWConfigSchema = z.object({
  // 下载确认用
  username: z.string().default(''),
  password: z.string().default(''),
  // 上传用
  certificates: z.array(LoTWCertificateSummarySchema).default([]),
  uploadLocation: LoTWUploadLocationSchema.default(DEFAULT_UPLOAD_LOCATION),
  stationLocations: z.array(LoTWUploadLocationSchema).default([]),
  defaultStationLocationId: z.string().optional(),
  autoUploadQSO: z.boolean().default(false),
  lastUploadTime: z.number().optional(),
  lastDownloadTime: z.number().optional(),
});

/**
 * LoTW 测试连接请求 Schema
 */
export const LoTWTestConnectionRequestSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

/**
 * LoTW 测试连接响应 Schema
 */
export const LoTWTestConnectionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const LoTWCertificateImportResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  certificate: LoTWCertificateSummarySchema.optional(),
});

export const LoTWCertificateDeleteResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  deletedId: z.string(),
});

export const LoTWUploadIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
});

export const LoTWUploadPreflightRequestSchema = z.object({}).default({});

export const LoTWUploadLocationSummarySchema = z.object({
  callsign: z.string().default(''),
  dxccId: z.number().int().positive().optional(),
  gridSquare: z.string().default(''),
  cqZone: z.string().default(''),
  ituZone: z.string().default(''),
  state: z.string().default(''),
  county: z.string().default(''),
});

export const LoTWUploadPreflightResponseSchema = z.object({
  ready: z.boolean(),
  pendingCount: z.number().default(0),
  uploadableCount: z.number().default(0),
  blockedCount: z.number().default(0),
  matchedCertificateIds: z.array(z.string()).default([]),
  selectedCertificates: z.array(LoTWCertificateSummarySchema).default([]),
  locationSummary: LoTWUploadLocationSummarySchema.optional(),
  issues: z.array(LoTWUploadIssueSchema).default([]),
  guidance: z.array(z.string()).default([]),
});

/**
 * LoTW 同步请求 Schema
 */
export const LoTWSyncRequestSchema = z.object({
  operation: z.enum(['upload', 'download_confirmations']),
  since: z.string().optional(),
});

/**
 * LoTW 同步响应 Schema
 */
export const LoTWSyncResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  errorCode: z.string().optional(),
  uploadedCount: z.number().default(0),
  downloadedCount: z.number().default(0),
  confirmedCount: z.number().default(0),
  updatedCount: z.number().default(0),
  importedCount: z.number().default(0),
  errorCount: z.number().default(0),
  errors: z.array(z.string()).optional(),
  syncTime: z.number(),
});

export const LoTWSyncStatusSchema = z.object({
  configured: z.boolean(),
  certificateCount: z.number().default(0),
  uploadLocationConfigured: z.boolean(),
  uploadConfigured: z.boolean(),
  serviceAvailable: z.boolean(),
  lastUploadTime: z.number().optional(),
  lastDownloadTime: z.number().optional(),
  autoUpload: z.boolean().default(false),
});

// ========== 类型导出 ==========

export type LoTWCertificateStatus = z.infer<typeof LoTWCertificateStatusSchema>;
export type LoTWCertificateSummary = z.infer<typeof LoTWCertificateSummarySchema>;
export type LoTWUploadLocation = z.infer<typeof LoTWUploadLocationSchema>;
export type LoTWConfig = z.infer<typeof LoTWConfigSchema>;
export type LoTWTestConnectionRequest = z.infer<typeof LoTWTestConnectionRequestSchema>;
export type LoTWTestConnectionResponse = z.infer<typeof LoTWTestConnectionResponseSchema>;
export type LoTWCertificateImportResponse = z.infer<typeof LoTWCertificateImportResponseSchema>;
export type LoTWCertificateDeleteResponse = z.infer<typeof LoTWCertificateDeleteResponseSchema>;
export type LoTWUploadIssue = z.infer<typeof LoTWUploadIssueSchema>;
export type LoTWUploadLocationSummary = z.infer<typeof LoTWUploadLocationSummarySchema>;
export type LoTWUploadPreflightRequest = z.infer<typeof LoTWUploadPreflightRequestSchema>;
export type LoTWUploadPreflightResponse = z.infer<typeof LoTWUploadPreflightResponseSchema>;
export type LoTWSyncRequest = z.infer<typeof LoTWSyncRequestSchema>;
export type LoTWSyncResponse = z.infer<typeof LoTWSyncResponseSchema>;
export type LoTWSyncStatus = z.infer<typeof LoTWSyncStatusSchema>;
