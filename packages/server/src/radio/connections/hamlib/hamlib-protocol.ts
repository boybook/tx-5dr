import { z } from 'zod';
import { HamlibConfigSchema, MeterCapabilitiesSchema, MeterDataSchema, TunerCapabilitiesSchema, TunerStatusSchema, TxAudioInputSourceSchema } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../../utils/errors/RadioError.js';
import type { HamlibRuntime } from './HamlibRuntime.js';

const number = z.number().finite();
type DiagnosticValue = string | number | boolean | null | undefined | DiagnosticValue[] | { [key: string]: DiagnosticValue };
const diagnosticValue: z.ZodType<DiagnosticValue> = z.lazy(() => z.union([z.string(), number, z.boolean(), z.null(), z.undefined(), z.array(diagnosticValue), z.record(diagnosticValue)]));
const bandwidth = z.union([number, z.enum(['narrow', 'wide', 'normal', 'nochange'])]);
const modeOptions = z.object({ intent: z.enum(['voice', 'digital', 'cw']).optional() });
const displayConfig = z.object({ mode: z.enum(['center', 'fixed', 'scroll-center', 'scroll-fixed']).optional(), spanHz: number.optional(), edgeSlot: number.optional(), edgeLowHz: number.optional(), edgeHighHz: number.optional() });
const displayState = displayConfig.extend({ mode: displayConfig.shape.mode.unwrap().nullable(), spanHz: number.nullable(), edgeSlot: number.nullable(), edgeLowHz: number.nullable(), edgeHighHz: number.nullable(), supportedSpans: z.array(number), supportsFixedEdges: z.boolean(), supportsEdgeSlotSelection: z.boolean() });
const namedNumber = z.object({ id: number, name: z.string() });
const summary = z.object({ supported: z.boolean(), asyncDataSupported: z.boolean(), hasSpectrumFunction: z.boolean(), hasSpectrumHoldFunction: z.boolean(), hasTransceiveFunction: z.boolean(), configurableLevels: z.array(z.string()), supportsFixedEdges: z.boolean(), supportsEdgeSlotSelection: z.boolean(), supportedEdgeSlots: z.array(number), scopes: z.array(namedNumber), modes: z.array(namedNumber), spans: z.array(number), avgModes: z.array(namedNumber) });

export const HamlibErrorSchema = z.object({
  __hamlibError: z.literal(true), name: z.string(), message: z.string(), stack: z.string().optional(),
  code: z.nativeEnum(RadioErrorCode).optional(), severity: z.nativeEnum(RadioErrorSeverity).optional(),
  userMessage: z.string().optional(), userMessageKey: z.string().optional(),
  userMessageParams: z.record(z.union([z.string(), number])).optional(), suggestions: z.array(z.string()).optional(),
  context: z.record(diagnosticValue).optional(),
});

export function serializeHamlibError(error: unknown): z.infer<typeof HamlibErrorSchema> {
  const value = error instanceof Error ? error : new Error(String(error));
  return HamlibErrorSchema.parse({ __hamlibError: true, name: value.name, message: value.message, stack: value.stack,
    ...(value instanceof RadioError ? { code: value.code, severity: value.severity, userMessage: value.userMessage,
      userMessageKey: value.userMessageKey, userMessageParams: value.userMessageParams, suggestions: value.suggestions, context: value.context } : {}) });
}

export function deserializeHamlibError(input: unknown): Error {
  const value = HamlibErrorSchema.parse(input);
  const error = value.code ? new RadioError({ ...value, code: value.code }) : new Error(value.message);
  error.name = value.name;
  if (value.stack) error.stack = value.stack;
  return error;
}

function operations<const Names extends readonly string[], Args extends z.ZodTypeAny, Result extends z.ZodTypeAny>(names: Names, args: Args, result: Result) {
  return Object.fromEntries(names.map(name => [name, { args, result }])) as { [K in Names[number]]: { args: Args; result: Result } };
}

const empty = z.tuple([]);
export const HAMLIB_OPERATIONS = {
  ...operations(['getFrequency', 'getRFPower', 'getAFGain', 'getSQL', 'getMicGain', 'getCompressorLevel', 'getMonitorGain', 'getNBLevel', 'getNRLevel', 'getPreampLevel', 'getAttenuatorLevel', 'getRitOffset', 'getXitOffset', 'getTuningStep', 'getRepeaterOffset', 'getCtcssTone', 'getDcsCode', 'getMaxRit', 'getMaxXit'] as const, empty, number),
  ...operations(['setFrequency', 'setRFPower', 'setAFGain', 'setSQL', 'setMicGain', 'setCompressorLevel', 'setMonitorGain', 'setNBLevel', 'setNRLevel', 'setPreampLevel', 'setAttenuatorLevel', 'setRitOffset', 'setXitOffset', 'setTuningStep', 'setRepeaterOffset', 'setCtcssTone', 'setDcsCode', 'setSpectrumSpan', 'setSplitFrequency'] as const, z.tuple([number]), z.void()),
  ...operations(['getPTT', 'getDCD', 'getCompressorEnabled', 'getNBEnabled', 'getNREnabled', 'getLockMode', 'getMuteEnabled', 'getVOXEnabled', 'getSplitEnabled', 'startTuning'] as const, empty, z.boolean()),
  ...operations(['setPTT', 'setTuner', 'setCompressorEnabled', 'setNBEnabled', 'setNREnabled', 'setLockMode', 'setMuteEnabled', 'setVOXEnabled', 'setSplitEnabled'] as const, z.tuple([z.boolean()]), z.void()),
  ...operations(['getAgcMode', 'getPowerState', 'getRepeaterShift'] as const, empty, z.string()),
  ...operations(['setAgcMode', 'setPowerState', 'setRepeaterShift'] as const, z.tuple([z.string()]), z.void()),
  ...operations(['getSupportedPreampLevels', 'getSupportedAttenuatorLevels', 'getSupportedTuningSteps', 'getAvailableCtcssTones', 'getAvailableDcsCodes', 'getSpectrumSpans'] as const, empty, z.array(number)),
  ...operations(['getSupportedModes', 'getSupportedAgcModes'] as const, empty, z.array(z.string())),
  ...operations(['promoteToFull', 'waitCWMessage', 'stopCWMessage', 'stopManagedSpectrum', 'startBackgroundTasks'] as const, empty, z.void()),
  connect: { args: z.tuple([HamlibConfigSchema, z.object({ mode: z.enum(['full', 'control-only']).optional() }).optional()]), result: z.void() },
  disconnect: { args: z.tuple([z.string().optional()]), result: z.void() },
  probeResponding: { args: z.tuple([number]), result: z.boolean() },
  setKnownFrequency: { args: z.tuple([number]), result: z.void() },
  sendCWMessage: { args: z.tuple([z.string(), number]), result: z.void() },
  setMode: { args: z.tuple([z.string(), bandwidth.optional(), modeOptions.optional()]), result: z.void() },
  getMode: { args: empty, result: z.object({ mode: z.string(), bandwidth: z.union([z.string(), number]) }) },
  getModeBandwidth: { args: empty, result: z.union([z.string(), number]) },
  setModeBandwidth: { args: z.tuple([bandwidth]), result: z.void() },
  getSupportedModeBandwidths: { args: empty, result: z.array(z.union([z.string(), number])) },
  applyOperatingState: { args: z.tuple([z.object({ frequency: number.optional(), mode: z.string().optional(), bandwidth: bandwidth.optional(), options: modeOptions.optional(), tolerateModeFailure: z.boolean().optional() })]), result: z.object({ frequencyApplied: z.boolean(), modeApplied: z.boolean(), frequencyConfirmed: z.boolean().optional(), observedFrequency: number.optional(), modeConfirmed: z.boolean().optional(), operationId: z.string().optional(), modeError: HamlibErrorSchema.optional() }) },
  getSpectrumSupportSummary: { args: empty, result: summary },
  getCurrentSpectrumSpan: { args: empty, result: number.nullable() },
  getSplitFrequency: { args: empty, result: number.nullable() },
  setSplitFreqMode: { args: z.tuple([number, z.string(), number]), result: z.void() },
  getSpectrumDisplayState: { args: empty, result: displayState.nullable() },
  configureSpectrumDisplay: { args: z.tuple([displayConfig]), result: z.void() },
  applySpectrumRuntimeConfig: { args: z.tuple([z.object({ speed: number })]), result: z.void() },
  startManagedSpectrum: { args: z.tuple([z.object({ speed: number.optional(), mode: z.union([z.string(), number]).optional(), spanHz: number.optional(), edgeSlot: number.optional(), edgeLowHz: number.optional(), edgeHighHz: number.optional(), hold: z.boolean().optional(), referenceLevel: number.optional(), averageMode: number.optional() }).optional()]), result: z.void() },
  getTunerCapabilities: { args: empty, result: TunerCapabilitiesSchema },
  getTunerStatus: { args: empty, result: TunerStatusSchema },
  getSupportedRFPowerSteps: { args: empty, result: z.array(z.object({ value: number, label: z.string().optional() })).nullable() },
  getTxAudioInputSource: { args: empty, result: TxAudioInputSourceSchema.nullable() },
  getSupportedTxAudioInputSources: { args: empty, result: z.array(TxAudioInputSourceSchema) },
  setTxAudioInputSource: { args: z.tuple([TxAudioInputSourceSchema]), result: z.object({ requested: TxAudioInputSourceSchema, applied: TxAudioInputSourceSchema, outcome: z.enum(['applied', 'clamped']), acknowledgement: z.enum(['state', 'reply', 'readback']) }) },
  listSupportedRigs: { args: empty, result: z.array(z.object({ rigModel: number, mfgName: z.string(), modelName: z.string() })) },
  getRigMetadata: { args: z.tuple([number]), result: z.object({ fields: z.array(z.object({ token: number, name: z.string(), label: z.string(), tooltip: z.string(), defaultValue: z.string(), type: z.string(), numeric: z.object({ min: number, max: number, step: number }).optional(), options: z.array(z.string()).optional() })), portCaps: z.object({ portType: z.string(), serialRateMin: number.optional(), serialRateMax: number.optional(), serialDataBits: number.optional(), serialStopBits: number.optional(), serialParity: z.string().optional(), serialHandshake: z.string().optional(), timeout: number.optional(), retry: number.optional(), writeDelay: number.optional(), postWriteDelay: number.optional() }).passthrough() }) },
} as const;

export type HamlibOperation = keyof typeof HAMLIB_OPERATIONS;
type AsyncRuntimeOperation = { [K in keyof HamlibRuntime]: HamlibRuntime[K] extends (...args: never[]) => Promise<unknown> ? K : never }[keyof HamlibRuntime];
type AssertCovered<T extends HamlibOperation> = T;
export type HamlibRuntimeOperationCoverage = AssertCovered<AsyncRuntimeOperation>;
export const HamlibOperationSchema = z.enum(Object.keys(HAMLIB_OPERATIONS) as [HamlibOperation, ...HamlibOperation[]]);
export const HamlibCommandSchema = z.object({ type: z.literal('call'), generation: z.string(), id: z.number().int().positive(), operation: HamlibOperationSchema, args: z.array(z.unknown()) });
export type HamlibCommand = z.infer<typeof HamlibCommandSchema>;

export const HamlibActivitySchema = z.object({ id: z.number().int(), operation: z.string(), startedAt: number, timeoutMs: number });
export const HamlibQueueSnapshotSchema = z.object({ label: z.string().optional(), busy: z.boolean(), backpressure: z.boolean(), criticalActive: z.boolean(), activeCount: number, activeTask: z.string().nullable(), activeRunMs: number.nullable(), pendingCount: number, criticalPendingCount: number, normalPendingCount: number, oldestPendingTask: z.string().nullable(), oldestPendingWaitMs: number.nullable(), dedupedTaskCount: number });
export const HamlibSnapshotSchema = z.object({ state: z.enum(['disconnected', 'connecting', 'connected', 'control_only', 'error']), healthy: z.boolean(), lastSuccessfulOperation: number, queue: HamlibQueueSnapshotSchema, meterCapabilities: MeterCapabilitiesSchema, levels: z.array(z.string()), functions: z.array(z.string()), parms: z.array(z.string()), vfoOps: z.array(z.string()), activities: z.array(HamlibActivitySchema), fault: HamlibErrorSchema.optional() });
export type HamlibSnapshot = z.infer<typeof HamlibSnapshotSchema>;

const calibrationNumber = z.union([z.number(), z.nan()]);
export const HamlibSpectrumLineSchema = z.object({ scopeId: number, dataLevelMin: calibrationNumber, dataLevelMax: calibrationNumber, signalStrengthMin: calibrationNumber, signalStrengthMax: calibrationNumber, mode: number, centerFreq: number, spanHz: number, lowEdgeFreq: number, highEdgeFreq: number, dataLength: z.number().int().nonnegative().max(65536), data: z.instanceof(Buffer).refine(value => value.length <= 65536), timestamp: number }).refine(value => value.dataLength <= value.data.length);
export const HamlibEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('stateChanged'), args: z.tuple([HamlibSnapshotSchema.shape.state]) }),
  z.object({ event: z.literal('connected'), args: empty }),
  z.object({ event: z.literal('disconnected'), args: z.tuple([z.string().optional()]) }),
  z.object({ event: z.literal('error'), args: z.tuple([HamlibErrorSchema]) }),
  z.object({ event: z.literal('frequencyChanged'), args: z.tuple([number]) }),
  z.object({ event: z.literal('meterData'), args: z.tuple([MeterDataSchema]) }),
  z.object({ event: z.literal('meterCapabilitiesChanged'), args: z.tuple([MeterCapabilitiesSchema]) }),
  z.object({ event: z.literal('spectrumLine'), args: z.tuple([HamlibSpectrumLineSchema]) }),
]);
export type HamlibEvent = z.infer<typeof HamlibEventSchema>;
export const HamlibWorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), generation: z.string(), version: z.literal(1) }),
  z.object({ type: z.literal('snapshot'), generation: z.string(), snapshot: HamlibSnapshotSchema }),
  z.object({ type: z.literal('result'), generation: z.string(), id: z.number().int(), operation: HamlibOperationSchema, result: z.unknown() }),
  z.object({ type: z.literal('error'), generation: z.string(), id: z.number().int(), error: HamlibErrorSchema }),
  z.object({ type: z.literal('event'), generation: z.string(), payload: HamlibEventSchema }),
  z.object({ type: z.literal('fault'), generation: z.string(), error: HamlibErrorSchema }),
]);

export function encodeHamlibResult(operation: HamlibOperation, result: unknown): unknown {
  const value = operation === 'applyOperatingState' && result && typeof result === 'object' && 'modeError' in result
    ? { ...result, modeError: result.modeError ? serializeHamlibError(result.modeError) : undefined } : result;
  return HAMLIB_OPERATIONS[operation].result.parse(value);
}

export function decodeHamlibResult(operation: HamlibOperation, input: unknown): unknown {
  const value = HAMLIB_OPERATIONS[operation].result.parse(input);
  if (operation === 'applyOperatingState' && value && typeof value === 'object' && 'modeError' in value && value.modeError) {
    return { ...value, modeError: deserializeHamlibError(value.modeError) };
  }
  return value;
}
