import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { summarizeWWDigiScore } from '../../score.js';

interface ContestQso {
  qsoId: string;
  callsign: string;
  myCallsign: string;
  sentGrid: string;
  receivedGrid?: string;
  frequencyHz: number;
  band: string;
  mode: 'FT4' | 'FT8';
  startTime: number;
  status: 'included' | 'x-qso' | 'review';
  source?: string;
  transmitterId?: 0 | 1;
}

interface PageState {
  config: {
    callsign: string; location: string; categoryBand: string; categoryPower: string;
    categoryOperator?: string; categoryTransmitter?: string; operators?: string[];
  };
  contestYear: number;
  deadline?: number;
  records: ContestQso[];
  health: { state?: string; error?: string };
  setup: { status: 'unconfirmed' | 'confirmed'; confirmedAt?: number };
  station: { callsign: string; grid: string; requiresSection: boolean };
}

type ImportIssue =
  | 'invalid-record' | 'invalid-callsign' | 'invalid-time' | 'outside-contest-period'
  | 'unsupported-mode' | 'missing-frequency' | 'invalid-frequency' | 'unsupported-band'
  | 'station-mismatch' | 'missing-station-callsign' | 'missing-my-grid'
  | 'my-grid-mismatch' | 'missing-grid' | 'missing-transmitter' | 'possible-duplicate';

interface ImportPreview {
  token: string;
  fileName: string;
  summary: {
    totalRead: number;
    importable: number;
    review: number;
    duplicates: number;
    rejected: number;
    missingStationCallsign: number;
    missingMyGrid: number;
    issueCounts: Partial<Record<ImportIssue, number>>;
    rows: Array<{
      sourceIndex: number;
      callsign?: string;
      startTime?: number;
      mode?: string;
      band?: string;
      status: 'ready' | 'review' | 'duplicate' | 'rejected';
      issues: ImportIssue[];
    }>;
  };
}

const MAX_IMPORT_BYTES = 700 * 1024;

const text = {
  zh: {
    download: '下载 Cabrillo', downloadAdif: '下载 ADIF', importAdif: '导入 ADIF', empty: '暂无比赛通联', time: 'UTC', call: '对方呼号',
    exchange: '交换', mode: '模式', band: '波段', source: '来源', status: '状态', included: '计入', excluded: '不计入', review: '待审核',
    dupe: '重复', save: '保存并确认比赛设置', setupRequired: '请确认本届比赛设置；确认前仅接收，发射已禁用。',
    contestTitle: 'WW Digi {{year}}', station: '参赛电台', grid: '网格', deadline: '日志提交截止',
    settingsTitle: '参赛与日志设置', settingsDesc: '这些信息将写入 Cabrillo 日志头部，并决定最终参赛类别。',
    expandSettings: '展开设置', collapseSettings: '收起设置', unsaved: '未保存',
    ledgerStatus: '日志状态',
    scoreTitle: '实时计分', claimedScore: '预估总分', scoredQsos: '计分 QSO', qsoPoints: 'QSO 分', gridFields: '网格场系数', reviewCount: '需处理',
    bandQso: 'QSO', points: '分值', multiplier: '系数', newMultiplier: '新系数', actionsLabel: '操作', moreActions: '更多操作',
    markExcluded: '标记为不计入（X-QSO）', restoreIncluded: '恢复计入',
    operatorLabel: '操作员类别', operatorHelp: '选择由一人完成全部操作与日志，或由多人共同参赛。',
    transmitterLabel: '发射机类别', bandLabel: '参赛波段', powerLabel: '功率类别',
    locationLabel: '参赛地区（LOCATION）', locationSectionHelp: '美国和加拿大电台必须填写 ARRL/RAC 分区，例如 OH、EMA 或 ON。',
    locationDxHelp: '美国和加拿大以外的电台按官方要求使用 DX。',
    operatorsLabel: '操作员呼号', operatorsRequired: '多人组必填；使用空格或逗号分隔。',
    operatorsOptional: '单人组可留空；若在他人电台操作，可填写实际操作员呼号。',
    invalidGrid: '电台操作员的网格必须是有效的 4 位 Maidenhead 网格。',
    missingLocation: '请填写参赛地点对应的 ARRL/RAC 分区。', missingOperators: '多人组至少需要一位操作员呼号。',
    operatorOptions: { 'SINGLE-OP': '单人（SINGLE-OP）', 'MULTI-OP': '多人（MULTI-OP）', CHECKLOG: '检查日志，不计分（CHECKLOG）' },
    transmitterOptions: { ONE: '单发射机（ONE）', TWO: '双发射机（TWO）', UNLIMITED: '多发射机（UNLIMITED）' },
    transmitterHelp: {
      ONE: '同一时间只允许一个发射信号；多人组每小时最多换波段 8 次。',
      TWO: '仅多人组：可在两个不同波段同时发射；每条 QSO 必须标记发射机 0 或 1。',
      UNLIMITED: '仅限全波段，可同时启用六个比赛波段。',
    },
    bandOptions: { ALL: '全波段（ALL）', '160M': '160 米（160M）', '80M': '80 米（80M）', '40M': '40 米（40M）', '20M': '20 米（20M）', '15M': '15 米（15M）', '10M': '10 米（10M）' },
    bandHelp: '选择单波段参赛时仍需上报全部波段 QSO，但只有所选波段计分。',
    powerOptions: { HIGH: '高功率（不超过 1500 W）', LOW: '低功率（不超过 100 W）', QRP: 'QRP（不超过 5 W）' },
    powerHelp: '功率限制按每个波段任一时刻的总输出功率计算。',
    health: { healthy: '正常', degraded: '需处理', unknown: '检查中' },
    importTitle: '导入比赛日志', importDesc: '仅导入当前届次、FT4/FT8 和允许波段的记录。确认前不会写入。',
    importTotal: '读取', importReady: '可导入', importReview: '待审核', importDuplicates: '已存在', importRejected: '忽略',
    importConfirmStation: '缺少台站呼号的记录均属于当前参赛电台 {{callsign}}。',
    importConfirmGrid: '缺少本台网格的记录使用当前网格 {{grid}}。',
    importCancel: '取消', importCommit: '导入 {{count}} 条', importFileTooLarge: 'ADIF 文件不能超过 700 KiB。',
    importSuccess: '已导入 {{imported}} 条，补全 {{merged}} 条，跳过 {{duplicates}} 条重复记录。',
    importStatus: { ready: '可导入', review: '待审核', duplicate: '已存在', rejected: '忽略' },
    importIssues: {
      'invalid-record': '记录格式无效', 'invalid-callsign': '呼号无效', 'invalid-time': '时间无效',
      'outside-contest-period': '不在本届比赛时间内', 'unsupported-mode': '不是 FT4/FT8',
      'missing-frequency': '缺少频率', 'invalid-frequency': '频率无效', 'unsupported-band': '不属于比赛波段',
      'station-mismatch': '台站呼号不一致', 'missing-station-callsign': '缺少台站呼号',
      'missing-my-grid': '缺少本台网格', 'my-grid-mismatch': '本台网格与当前设置不同',
      'missing-grid': '缺少对方网格，将按 ZZ00 审核', 'missing-transmitter': '双发射机记录需指定 TX 0/1', 'possible-duplicate': '疑似重复记录',
    },
    importErrors: {
      adif_import_file_missing: '未能读取上传的 ADIF 文件。', adif_import_file_too_large: 'ADIF 文件过大。',
      adif_import_preview_expired: '导入预览已过期，请重新选择文件。', adif_import_confirmation_required: '请确认缺失的台站信息。',
      adif_import_revision_conflict: '比赛日志正在变化，请重新预览后导入。', adif_import_station_grid_invalid: '请先设置有效的 4 位本台网格。',
    },
  },
  ja: {
    download: 'Cabrillo を保存', downloadAdif: 'ADIF を保存', importAdif: 'ADIF を読込', empty: 'QSO はありません', time: 'UTC', call: '相手局',
    exchange: '交換', mode: 'モード', band: 'バンド', source: '出所', status: '状態', included: '有効', excluded: '対象外', review: '要確認',
    dupe: '重複', save: '保存して競技設定を確認', setupRequired: 'この大会の設定を確認してください。確認するまで受信のみで、送信は無効です。',
    contestTitle: 'WW Digi {{year}}', station: '参加局', grid: 'グリッド', deadline: 'ログ提出期限',
    settingsTitle: '参加カテゴリとログ設定', settingsDesc: 'この情報は Cabrillo ヘッダーに記録され、参加カテゴリを決定します。',
    expandSettings: '設定を開く', collapseSettings: '設定を閉じる', unsaved: '未保存',
    ledgerStatus: 'ログ状態',
    scoreTitle: 'リアルタイム得点', claimedScore: '暫定スコア', scoredQsos: '得点 QSO', qsoPoints: 'QSO 点', gridFields: 'グリッドマルチ', reviewCount: '要確認',
    bandQso: 'QSO', points: '点', multiplier: 'マルチ', newMultiplier: '新マルチ', actionsLabel: '操作', moreActions: 'その他の操作',
    markExcluded: 'X-QSO（対象外）にする', restoreIncluded: '有効に戻す',
    operatorLabel: 'オペレーター区分', operatorHelp: '全操作と記録を一人で行うか、複数人で参加するかを選択します。',
    transmitterLabel: '送信機区分', bandLabel: '参加バンド', powerLabel: '出力区分',
    locationLabel: '参加地域（LOCATION）', locationSectionHelp: '米国・カナダ局は OH、EMA、ON などの ARRL/RAC セクションが必要です。',
    locationDxHelp: '米国・カナダ以外の局は公式指定の DX を使用します。',
    operatorsLabel: 'オペレーターコール', operatorsRequired: 'マルチオペでは必須です。空白またはコンマで区切ります。',
    operatorsOptional: 'シングルオペでは省略できます。他局設備で運用した場合は実際のオペレーターを記載できます。',
    invalidGrid: 'オペレーター局のグリッドは有効な4桁 Maidenhead グリッドである必要があります。',
    missingLocation: '運用地点の ARRL/RAC セクションを入力してください。', missingOperators: 'マルチオペでは1局以上のオペレーターが必要です。',
    operatorOptions: { 'SINGLE-OP': 'シングルオペ（SINGLE-OP）', 'MULTI-OP': 'マルチオペ（MULTI-OP）', CHECKLOG: 'チェックログ・得点なし（CHECKLOG）' },
    transmitterOptions: { ONE: '1送信機（ONE）', TWO: '2送信機（TWO）', UNLIMITED: '複数送信機（UNLIMITED）' },
    transmitterHelp: {
      ONE: '同時に送信できる信号は1つです。マルチオペでは1時間に最大8回のバンド変更が可能です。',
      TWO: 'マルチオペのみ。異なる2バンドで同時送信でき、各 QSO に送信機 0/1 の記録が必要です。',
      UNLIMITED: 'オールバンドのみ。6つのコンテストバンドを同時に使用できます。',
    },
    bandOptions: { ALL: 'オールバンド（ALL）', '160M': '160 m（160M）', '80M': '80 m（80M）', '40M': '40 m（40M）', '20M': '20 m（20M）', '15M': '15 m（15M）', '10M': '10 m（10M）' },
    bandHelp: 'シングルバンド参加でも全バンドの QSO を提出し、指定バンドのみが得点になります。',
    powerOptions: { HIGH: 'ハイパワー（1500 W以下）', LOW: 'ローパワー（100 W以下）', QRP: 'QRP（5 W以下）' },
    powerHelp: '出力制限は各バンドで任意の時点における合計送信出力です。',
    health: { healthy: '正常', degraded: '要確認', unknown: '確認中' },
    importTitle: 'コンテストログを読込', importDesc: '選択中の大会期間、FT4/FT8、対象バンドの QSO のみを確認後に取り込みます。',
    importTotal: '読込', importReady: '取込可能', importReview: '要確認', importDuplicates: '登録済み', importRejected: '対象外',
    importConfirmStation: '局コールがない QSO は現在の参加局 {{callsign}} の記録です。',
    importConfirmGrid: '自局グリッドがない QSO には現在の {{grid}} を使用します。',
    importCancel: 'キャンセル', importCommit: '{{count}} 件を取込', importFileTooLarge: 'ADIF ファイルは 700 KiB 以下にしてください。',
    importSuccess: '{{imported}} 件を追加、{{merged}} 件を補完、重複 {{duplicates}} 件をスキップしました。',
    importStatus: { ready: '取込可能', review: '要確認', duplicate: '登録済み', rejected: '対象外' },
    importIssues: {
      'invalid-record': 'レコード形式が無効', 'invalid-callsign': 'コールサインが無効', 'invalid-time': '日時が無効',
      'outside-contest-period': '大会期間外', 'unsupported-mode': 'FT4/FT8 ではない',
      'missing-frequency': '周波数なし', 'invalid-frequency': '周波数が無効', 'unsupported-band': '対象バンド外',
      'station-mismatch': '参加局コールが不一致', 'missing-station-callsign': '参加局コールなし',
      'missing-my-grid': '自局グリッドなし', 'my-grid-mismatch': '自局グリッドが現在設定と異なる',
      'missing-grid': '相手グリッドなし。ZZ00 として確認', 'missing-transmitter': '2送信機ログは TX 0/1 の指定が必要', 'possible-duplicate': '重複の可能性',
    },
    importErrors: {
      adif_import_file_missing: 'アップロードした ADIF を読み取れません。', adif_import_file_too_large: 'ADIF ファイルが大きすぎます。',
      adif_import_preview_expired: '取込プレビューの期限が切れました。もう一度選択してください。', adif_import_confirmation_required: '不足している局情報を確認してください。',
      adif_import_revision_conflict: 'ログが更新中です。もう一度プレビューしてください。', adif_import_station_grid_invalid: '先に有効な4桁の自局グリッドを設定してください。',
    },
  },
  en: {
    download: 'Download Cabrillo', downloadAdif: 'Download ADIF', importAdif: 'Import ADIF', empty: 'No contest QSOs', time: 'UTC', call: 'Callsign',
    exchange: 'Exchange', mode: 'Mode', band: 'Band', source: 'Source', status: 'Status', included: 'Included', excluded: 'Not counted', review: 'Review',
    dupe: 'Dupe', save: 'Save and confirm contest settings', setupRequired: 'Confirm this contest edition before transmitting. Receive-only operation remains available.',
    contestTitle: 'WW Digi {{year}}', station: 'Entrant station', grid: 'Grid', deadline: 'Log submission deadline',
    settingsTitle: 'Entry and log settings', settingsDesc: 'These values are written to the Cabrillo header and determine the entry category.',
    expandSettings: 'Expand settings', collapseSettings: 'Collapse settings', unsaved: 'Unsaved',
    ledgerStatus: 'Log status',
    scoreTitle: 'Live score', claimedScore: 'Claimed score', scoredQsos: 'Scored QSOs', qsoPoints: 'QSO points', gridFields: 'Grid multipliers', reviewCount: 'Needs review',
    bandQso: 'QSO', points: 'Points', multiplier: 'Multiplier', newMultiplier: 'New multiplier', actionsLabel: 'Actions', moreActions: 'More actions',
    markExcluded: 'Mark as X-QSO (not counted)', restoreIncluded: 'Restore as included',
    operatorLabel: 'Operator category', operatorHelp: 'Choose whether one person performs all operating and logging, or multiple operators participate.',
    transmitterLabel: 'Transmitter category', bandLabel: 'Entry band', powerLabel: 'Power category',
    locationLabel: 'Entry location (LOCATION)', locationSectionHelp: 'US and Canadian stations must enter an ARRL/RAC section such as OH, EMA, or ON.',
    locationDxHelp: 'Stations outside the US and Canada use the official DX location value.',
    operatorsLabel: 'Operator callsigns', operatorsRequired: 'Required for multi-operator entries; separate callsigns with spaces or commas.',
    operatorsOptional: 'Optional for single-operator entries; use it when operating at another station.',
    invalidGrid: 'The radio operator must have a valid four-character Maidenhead grid.',
    missingLocation: 'Enter the ARRL/RAC section for the station location.', missingOperators: 'A multi-operator entry requires at least one operator callsign.',
    operatorOptions: { 'SINGLE-OP': 'Single operator (SINGLE-OP)', 'MULTI-OP': 'Multi-operator (MULTI-OP)', CHECKLOG: 'Checklog, no score (CHECKLOG)' },
    transmitterOptions: { ONE: 'One transmitter (ONE)', TWO: 'Two transmitters (TWO)', UNLIMITED: 'Multiple transmitters (UNLIMITED)' },
    transmitterHelp: {
      ONE: 'Only one transmitted signal is permitted at a time. MULTI-ONE allows at most eight band changes per clock hour.',
      TWO: 'Multi-operator only: transmit on two different bands and identify transmitter 0 or 1 for every QSO.',
      UNLIMITED: 'All-band only; the six contest bands may be activated simultaneously.',
    },
    bandOptions: { ALL: 'All bands (ALL)', '160M': '160 metres (160M)', '80M': '80 metres (80M)', '40M': '40 metres (40M)', '20M': '20 metres (20M)', '15M': '15 metres (15M)', '10M': '10 metres (10M)' },
    bandHelp: 'Single-band entries must still submit every QSO; only the selected band is scored.',
    powerOptions: { HIGH: 'High power (up to 1500 W)', LOW: 'Low power (up to 100 W)', QRP: 'QRP (up to 5 W)' },
    powerHelp: 'The limit is total transmitter output on each band at any time.',
    health: { healthy: 'Healthy', degraded: 'Needs attention', unknown: 'Checking' },
    importTitle: 'Import contest log', importDesc: 'Only FT4/FT8 QSOs in this contest edition and its allowed bands will be imported after review.',
    importTotal: 'Read', importReady: 'Ready', importReview: 'Review', importDuplicates: 'Existing', importRejected: 'Ignored',
    importConfirmStation: 'Records without a station callsign belong to the current entrant {{callsign}}.',
    importConfirmGrid: 'Use the current grid {{grid}} for records without MY_GRIDSQUARE.',
    importCancel: 'Cancel', importCommit: 'Import {{count}}', importFileTooLarge: 'The ADIF file must not exceed 700 KiB.',
    importSuccess: 'Imported {{imported}}, completed {{merged}}, and skipped {{duplicates}} duplicate records.',
    importStatus: { ready: 'Ready', review: 'Review', duplicate: 'Existing', rejected: 'Ignored' },
    importIssues: {
      'invalid-record': 'Invalid record', 'invalid-callsign': 'Invalid callsign', 'invalid-time': 'Invalid time',
      'outside-contest-period': 'Outside this contest period', 'unsupported-mode': 'Not FT4/FT8',
      'missing-frequency': 'Missing frequency', 'invalid-frequency': 'Invalid frequency', 'unsupported-band': 'Not a contest band',
      'station-mismatch': 'Station callsign mismatch', 'missing-station-callsign': 'Missing station callsign',
      'missing-my-grid': 'Missing station grid', 'my-grid-mismatch': 'Station grid differs from current settings',
      'missing-grid': 'Missing remote grid; review as ZZ00', 'missing-transmitter': 'Multi-Two records need TX 0/1', 'possible-duplicate': 'Possible duplicate',
    },
    importErrors: {
      adif_import_file_missing: 'The uploaded ADIF file could not be read.', adif_import_file_too_large: 'The ADIF file is too large.',
      adif_import_preview_expired: 'The import preview expired. Select the file again.', adif_import_confirmation_required: 'Confirm the missing station details.',
      adif_import_revision_conflict: 'The contest log is changing. Preview the import again.', adif_import_station_grid_invalid: 'Set a valid four-character station grid first.',
    },
  },
};

type ContestConfig = PageState['config'];
type OperatorCategory = 'SINGLE-OP' | 'MULTI-OP' | 'CHECKLOG';
type TransmitterCategory = 'ONE' | 'TWO' | 'UNLIMITED';
type PowerCategory = 'HIGH' | 'LOW' | 'QRP';
const BANDS = ['ALL', '160M', '80M', '40M', '20M', '15M', '10M'] as const;

function operatorCategory(config: ContestConfig): OperatorCategory {
  return (config.categoryOperator ?? 'SINGLE-OP') as OperatorCategory;
}

function transmitterCategory(config: ContestConfig): TransmitterCategory {
  return (config.categoryTransmitter ?? 'ONE') as TransmitterCategory;
}

function normalizeCategoryDraft(config: ContestConfig): ContestConfig {
  const next = { ...config };
  const operator = operatorCategory(next);
  let transmitter = transmitterCategory(next);
  if (operator === 'SINGLE-OP' && transmitter === 'TWO') transmitter = 'ONE';
  next.categoryTransmitter = transmitter;
  if (operator === 'MULTI-OP' || transmitter === 'UNLIMITED') next.categoryBand = 'ALL';
  if (operator === 'MULTI-OP' && transmitter === 'ONE' && next.categoryPower === 'QRP') next.categoryPower = 'LOW';
  if (operator === 'MULTI-OP' && transmitter !== 'ONE') next.categoryPower = 'HIGH';
  return next;
}

function transmitterOptions(config: ContestConfig): TransmitterCategory[] {
  if (operatorCategory(config) === 'SINGLE-OP') return ['ONE', 'UNLIMITED'];
  return ['ONE', 'TWO', 'UNLIMITED'];
}

function powerOptions(config: ContestConfig): PowerCategory[] {
  if (operatorCategory(config) !== 'MULTI-OP') return ['HIGH', 'LOW', 'QRP'];
  return transmitterCategory(config) === 'ONE' ? ['HIGH', 'LOW'] : ['HIGH'];
}

function bandOptions(config: ContestConfig): readonly (typeof BANDS)[number][] {
  return operatorCategory(config) === 'MULTI-OP' || transmitterCategory(config) === 'UNLIMITED'
    ? ['ALL']
    : BANDS;
}

function formatDeadline(timestamp?: number): string {
  if (!timestamp) return '';
  const iso = new Date(timestamp).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function configFingerprint(config?: ContestConfig | null): string {
  if (!config) return '';
  return JSON.stringify({
    operator: operatorCategory(config),
    transmitter: transmitterCategory(config),
    band: config.categoryBand,
    power: config.categoryPower,
    location: config.location.trim().toUpperCase(),
    operators: [...(config.operators ?? [])].map((value) => value.trim().toUpperCase()).filter(Boolean).sort(),
  });
}

function interpolate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    template,
  );
}

export const wwDigiContestLogUiTestables = {
  normalizeCategoryDraft,
  transmitterOptions,
  powerOptions,
  bandOptions,
  formatDeadline,
  interpolate,
};

export function App() {
  const [bridgeLocale, setBridgeLocale] = useState('en');
  const locale = bridgeLocale.startsWith('zh') ? 'zh' : bridgeLocale.startsWith('ja') ? 'ja' : 'en';
  const t = text[locale];
  const [state, setState] = useState<PageState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<PageState['config'] | null>(null);
  const [settingsExpanded, setSettingsExpanded] = useState(true);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [confirmImportStation, setConfirmImportStation] = useState(false);
  const [confirmImportGrid, setConfirmImportGrid] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const settingsExpansionInitialized = useRef(false);
  const healthState = stateHealth(state?.health.state);

  const load = useCallback(async () => {
    setError('');
    const next = await tx5dr.invoke('getState', {}) as PageState;
    setState(next);
    setDraft(normalizeCategoryDraft({
      ...next.config,
      ...(!next.station.requiresSection ? { location: 'DX' } : {}),
    }));
    if (!settingsExpansionInitialized.current) {
      setSettingsExpanded(next.setup.status !== 'confirmed');
      settingsExpansionInitialized.current = true;
    }
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let handleStateChanged: (() => void) | undefined;
    void tx5dr.ready.then(async (bridgeState) => {
      if (!active) return;
      setBridgeLocale(bridgeState.locale);
      unsubscribe = tx5dr.onLocaleChange((nextLocale) => {
        if (active) setBridgeLocale(nextLocale);
      });
      handleStateChanged = () => {
        if (active) void load();
      };
      tx5dr.onPush('stateChanged', handleStateChanged);
      await load();
      if (!active) tx5dr.offPush('stateChanged', handleStateChanged);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
      unsubscribe?.();
      if (handleStateChanged) tx5dr.offPush('stateChanged', handleStateChanged);
    };
  }, [load]);

  const score = useMemo(() => summarizeWWDigiScore(
    state?.records ?? [],
    state?.config.categoryBand ?? 'ALL',
  ), [state?.config.categoryBand, state?.records]);
  const rows = useMemo(() => score.rows.map((row) => ({ ...row.record, ...row })), [score.rows]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const updateDraft = (patch: Partial<ContestConfig>) => {
    setDraft((current) => current ? normalizeCategoryDraft({ ...current, ...patch }) : current);
  };
  const draftOperator = draft ? operatorCategory(draft) : 'SINGLE-OP';
  const draftTransmitter = draft ? transmitterCategory(draft) : 'ONE';
  const settingsDirty = configFingerprint(draft) !== configFingerprint(state?.config);
  const settingsSummary = useMemo(() => {
    if (!draft) return '';
    const operators = (draft.operators ?? []).join(', ');
    return [
      t.operatorOptions[draftOperator],
      t.transmitterOptions[draftTransmitter],
      t.bandOptions[draft.categoryBand as keyof typeof t.bandOptions],
      t.powerOptions[draft.categoryPower as PowerCategory],
      draft.location.trim().toUpperCase(),
      operators ? `${t.operatorsLabel}: ${operators}` : undefined,
    ].filter(Boolean).join(' · ');
  }, [draft, draftOperator, draftTransmitter, t]);
  const formIssue = useMemo(() => {
    if (!state || !draft) return '';
    if (!/^[A-R]{2}\d{2}$/.test(state.station.grid)) return t.invalidGrid;
    if (state.station.requiresSection && (!draft.location.trim() || draft.location.trim().toUpperCase() === 'DX')) {
      return t.missingLocation;
    }
    if (operatorCategory(draft) === 'MULTI-OP' && (draft.operators ?? []).length === 0) {
      return t.missingOperators;
    }
    return '';
  }, [draft, state, t.invalidGrid, t.missingLocation, t.missingOperators]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(t.importErrors[message as keyof typeof t.importErrors] ?? message);
    }
    finally { setBusy(false); }
  };

  const download = () => run(async () => {
    const result = await tx5dr.invoke('renderCabrillo', {}) as { text: string };
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state?.config.callsign || 'ww-digi'}-ww-digi-${state?.contestYear || 'log'}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
  const downloadAdif = () => run(async () => {
    const result = await tx5dr.invoke('renderADIF', {}) as { text: string };
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state?.config.callsign || 'ww-digi'}-ww-digi-${state?.contestYear || 'log'}.adi`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
  const chooseImport = () => {
    if (!busy) importInputRef.current?.click();
  };
  const selectImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setError(t.importFileTooLarge);
      return;
    }
    setBusy(true); setError(''); setImportNotice('');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadPath = `imports/${Date.now()}-${safeName}`;
    try {
      await tx5dr.fileUpload(uploadPath, file);
      const preview = await tx5dr.invoke('previewADIFImport', {
        path: uploadPath,
        fileName: file.name,
      }) as ImportPreview;
      setImportPreview(preview);
      setConfirmImportStation(preview.summary.missingStationCallsign === 0);
      setConfirmImportGrid(preview.summary.missingMyGrid === 0);
    } catch (reason) {
      await tx5dr.fileDelete(uploadPath).catch(() => false);
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(t.importErrors[message as keyof typeof t.importErrors] ?? message);
    } finally {
      setBusy(false);
    }
  };
  const cancelImport = () => run(async () => {
    if (importPreview) await tx5dr.invoke('cancelADIFImport', { token: importPreview.token });
    setImportPreview(null);
  });
  const commitImport = () => run(async () => {
    if (!importPreview) return;
    const result = await tx5dr.invoke('commitADIFImport', {
      token: importPreview.token,
      confirmStationCallsign: confirmImportStation,
      confirmStationGrid: confirmImportGrid,
    }) as { imported: number; merged: number; duplicates: number };
    setImportNotice(interpolate(t.importSuccess, result));
    setImportPreview(null);
    await load();
  });
  const setStatus = (record: ContestQso, status: ContestQso['status']) => run(async () => {
    await tx5dr.invoke('setStatus', { qsoId: record.qsoId, status });
    await load();
  });
  const saveSession = () => run(async () => {
    if (!draft) return;
    await tx5dr.invoke('updateSession', { ...draft, operators: draft.operators ?? [] });
    await load();
    setSettingsExpanded(false);
  });
  const setTransmitter = (record: ContestQso, transmitterId: 0 | 1) => run(async () => {
    await tx5dr.invoke('setTransmitter', { qsoId: record.qsoId, transmitterId });
    await load();
  });

  return (
    <main className={settingsExpanded ? 'settings-expanded' : 'settings-collapsed'}>
      <input
        ref={importInputRef}
        className="sr-only"
        type="file"
        accept=".adi,.ADI,.adif,.ADIF"
        onChange={(event) => { void selectImportFile(event); }}
      />
      <header className="summary-bar">
        <div className="summary-copy">
          <h1>{state ? t.contestTitle.replace('{{year}}', String(state.contestYear)) : 'WW Digi'}</h1>
          {state?.station && (
            <div className="summary-meta">
              <span><strong>{t.station}</strong> {state.station.callsign}</span>
              <span><strong>{t.grid}</strong> {state.station.grid}</span>
            </div>
          )}
          {state?.deadline && <p><strong>{t.deadline}</strong> {formatDeadline(state.deadline)}</p>}
        </div>
        <div className="actions">
          <span
            className={`health health-${healthState}`}
            title={state?.health.error}
          >
            {t.ledgerStatus}: {t.health[healthState]}
          </span>
          <button
            type="button"
            className="button button-sm button-bordered"
            disabled={busy || !state || state.health.state !== 'healthy'}
            onClick={chooseImport}
          >{t.importAdif}</button>
          <button
            type="button"
            className="button button-sm button-flat"
            disabled={busy || !state || state.health.state !== 'healthy'}
            onClick={() => void downloadAdif()}
          >{t.downloadAdif}</button>
          <button
            type="button"
            className="button button-sm button-solid button-primary"
            disabled={busy || !state || state.health.state !== 'healthy' || state.setup.status !== 'confirmed'}
            onClick={() => void download()}
          >{t.download}</button>
        </div>
      </header>
      {error && <div role="alert" className="error">{error}</div>}
      {importNotice && <div role="status" className="import-notice">{importNotice}</div>}
      {state?.setup.status !== 'confirmed' && <div role="alert" className="setup-alert">{t.setupRequired}</div>}
      {draft && (
        <section className="settings-section" aria-labelledby="contest-settings-title">
          <div className="settings-heading">
            <button
              type="button"
              className="settings-toggle"
              aria-expanded={settingsExpanded}
              aria-controls="contest-settings-fields"
              onClick={() => setSettingsExpanded((expanded) => !expanded)}
            >
              <span className="settings-toggle-copy">
                <span className="settings-title-line">
                  <span id="contest-settings-title" className="settings-title">{t.settingsTitle}</span>
                  {settingsDirty && <span className="unsaved-indicator">{t.unsaved}</span>}
                </span>
                {settingsExpanded ? (
                  <span className="settings-description">{t.settingsDesc}</span>
                ) : (
                  <span className="settings-summary" title={settingsSummary}>{settingsSummary}</span>
                )}
              </span>
              <span className="settings-toggle-action">
                {settingsExpanded ? t.collapseSettings : t.expandSettings}
                <span className={`disclosure-chevron ${settingsExpanded ? 'is-expanded' : ''}`} aria-hidden="true" />
              </span>
            </button>
          </div>
          {settingsExpanded && <>
          <div id="contest-settings-fields" className="session-form">
            <label className="form-field">
              <span className="field-label">{t.operatorLabel}</span>
              <select
                value={draftOperator}
                onChange={(event) => updateDraft({ categoryOperator: event.target.value })}
              >
                {(['SINGLE-OP', 'MULTI-OP', 'CHECKLOG'] as OperatorCategory[]).map((value) => (
                  <option key={value} value={value}>{t.operatorOptions[value]}</option>
                ))}
              </select>
              <span className="field-help">{t.operatorHelp}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.transmitterLabel}</span>
              <select
                value={draftTransmitter}
                onChange={(event) => updateDraft({ categoryTransmitter: event.target.value })}
              >
                {transmitterOptions(draft).map((value) => (
                  <option key={value} value={value}>{t.transmitterOptions[value]}</option>
                ))}
              </select>
              <span className="field-help">{t.transmitterHelp[draftTransmitter]}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.bandLabel}</span>
              <select value={draft.categoryBand} onChange={(event) => updateDraft({ categoryBand: event.target.value })}>
                {bandOptions(draft).map((value) => <option key={value} value={value}>{t.bandOptions[value]}</option>)}
              </select>
              <span className="field-help">{t.bandHelp}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.powerLabel}</span>
              <select value={draft.categoryPower} onChange={(event) => updateDraft({ categoryPower: event.target.value })}>
                {powerOptions(draft).map((value) => <option key={value} value={value}>{t.powerOptions[value]}</option>)}
              </select>
              <span className="field-help">{t.powerHelp}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.locationLabel}</span>
              <input
                value={draft.location}
                disabled={!state?.station.requiresSection}
                required={state?.station.requiresSection}
                placeholder={state?.station.requiresSection ? 'OH / EMA / ON' : 'DX'}
                onChange={(event) => updateDraft({ location: event.target.value.toUpperCase() })}
              />
              <span className="field-help">{state?.station.requiresSection ? t.locationSectionHelp : t.locationDxHelp}</span>
            </label>

            <label className="form-field form-field-wide">
              <span className="field-label">{t.operatorsLabel}{draftOperator === 'MULTI-OP' ? ' *' : ''}</span>
              <input
                value={(draft.operators ?? []).join(', ')}
                required={draftOperator === 'MULTI-OP'}
                placeholder={draftOperator === 'MULTI-OP' ? 'K1ABC, JA1XYZ' : ''}
                onChange={(event) => updateDraft({
                  operators: event.target.value.split(/[\s,]+/).filter(Boolean).map((value) => value.toUpperCase()),
                })}
              />
              <span className="field-help">{draftOperator === 'MULTI-OP' ? t.operatorsRequired : t.operatorsOptional}</span>
            </label>
          </div>
          <div className="settings-footer">
            <span className="form-issue" role={formIssue ? 'alert' : undefined}>{formIssue}</span>
            <button
              className="button button-sm button-solid button-primary"
              type="button"
              disabled={busy || Boolean(formIssue)}
              onClick={() => void saveSession()}
            >{t.save}</button>
          </div>
          </>}
        </section>
      )}
      <section className="score-section" aria-labelledby="score-title">
        <div className="score-heading">
          <h2 id="score-title">{t.scoreTitle}</h2>
          <span className="score-entry-band">{state?.config.categoryBand ?? 'ALL'}</span>
        </div>
        <div className="score-totals">
          <div className="score-total score-total-primary">
            <span>{t.claimedScore}</span>
            <strong>{numberFormatter.format(score.claimedScore)}</strong>
          </div>
          <div className="score-total"><span>{t.scoredQsos}</span><strong>{score.scoredQsos}</strong></div>
          <div className="score-total"><span>{t.qsoPoints}</span><strong>{score.qsoPoints}</strong></div>
          <div className="score-total"><span>{t.gridFields}</span><strong>{score.gridFields}</strong></div>
          <div className={`score-total ${score.reviewCount > 0 ? 'score-total-warning' : ''}`}>
            <span>{t.reviewCount}</span><strong>{score.reviewCount}</strong>
          </div>
        </div>
        <div className="band-breakdown">
          {score.bands.map((band) => (
            <div
              key={band.band}
              className={`band-score ${band.qsos > 0 ? 'has-qsos' : ''} ${state?.config.categoryBand === band.band ? 'is-entry-band' : ''}`}
            >
              <strong className="band-name">{band.band}</strong>
              <span><b>{band.qsos}</b> {t.bandQso}</span>
              <span><b>{band.qsoPoints}</b> {t.points}</span>
              <span><b>{band.gridFields}</b> {t.gridFields}</span>
            </div>
          ))}
        </div>
      </section>
      <div className="table-shell">
        <table>
          <thead><tr>
            <th>{t.time}</th><th>{t.call}</th><th>{t.exchange}</th><th>{t.mode}</th><th>{t.band}</th>
            <th className="numeric">{t.points}</th><th>{t.multiplier}</th>
            {state?.config.categoryTransmitter === 'TWO' && <th>TX</th>}
            <th>{t.status}</th><th className="actions-column"><span className="sr-only">{t.actionsLabel}</span></th>
          </tr></thead>
          <tbody>
            {rows.map((record, rowIndex) => (
              <tr key={record.qsoId} className={record.status === 'x-qso' ? 'excluded' : ''}>
                <td>{new Date(record.startTime).toISOString().slice(5, 16).replace('T', ' ')}</td>
                <td className="call">{record.callsign}</td>
                <td>{record.sentGrid} / {record.receivedGrid || 'ZZ00'}</td>
                <td>{record.mode}</td><td>{record.band}</td>
                <td className="numeric score-points">{record.qsoPoints === null ? '-' : record.creditedPoints}</td>
                <td className="status-cell">
                  {record.gridField ? (
                    <span className={record.newMultiplier ? 'multiplier-new' : 'multiplier-field'}>
                      {record.gridField}{record.newMultiplier ? ' +1' : ''}
                    </span>
                  ) : '-'}
                </td>
                {state?.config.categoryTransmitter === 'TWO' && (
                  <td>
                    <select
                      className="tx-select"
                      value={record.transmitterId ?? ''}
                      disabled={busy}
                      onChange={(event) => void setTransmitter(record, Number(event.target.value) === 1 ? 1 : 0)}
                    >
                      <option value="" disabled>TX</option><option value="0">0</option><option value="1">1</option>
                    </select>
                  </td>
                )}
                <td>
                  <span className={`status status-${record.status === 'x-qso' ? 'excluded' : record.status === 'review' ? 'review' : record.dupe ? 'dupe' : 'included'}`}>
                    {record.status === 'x-qso' ? t.excluded : record.status === 'review' ? t.review : record.dupe ? t.dupe : t.included}
                  </span>
                </td>
                <td className="row-actions-cell">
                  <details
                    className={`row-actions ${rowIndex < 2 ? 'open-down' : ''} ${busy ? 'is-disabled' : ''}`}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute('open');
                    }}
                  >
                    <summary
                      aria-label={t.moreActions}
                      title={t.moreActions}
                      onClick={(event) => { if (busy) event.preventDefault(); }}
                    >...</summary>
                    <div className="row-actions-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className={record.status === 'x-qso' ? '' : 'danger'}
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          void setStatus(record, record.status === 'x-qso' ? 'included' : 'x-qso');
                        }}
                      >{record.status === 'x-qso' ? t.restoreIncluded : t.markExcluded}</button>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={state?.config.categoryTransmitter === 'TWO' ? 10 : 9} className="empty">{t.empty}</td></tr>}
          </tbody>
        </table>
      </div>
      {importPreview && (
        <div className="import-backdrop" role="presentation">
          <section
            className="import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-dialog-title"
          >
            <header className="import-dialog-header">
              <div>
                <h2 id="import-dialog-title">{t.importTitle}</h2>
                <p>{importPreview.fileName} · {t.importDesc}</p>
              </div>
            </header>
            <div className="import-summary">
              <div><span>{t.importTotal}</span><strong>{importPreview.summary.totalRead}</strong></div>
              <div><span>{t.importReady}</span><strong>{importPreview.summary.importable}</strong></div>
              <div className={importPreview.summary.review > 0 ? 'is-warning' : ''}>
                <span>{t.importReview}</span><strong>{importPreview.summary.review}</strong>
              </div>
              <div><span>{t.importDuplicates}</span><strong>{importPreview.summary.duplicates}</strong></div>
              <div className={importPreview.summary.rejected > 0 ? 'is-danger' : ''}>
                <span>{t.importRejected}</span><strong>{importPreview.summary.rejected}</strong>
              </div>
            </div>
            {(importPreview.summary.missingStationCallsign > 0 || importPreview.summary.missingMyGrid > 0) && (
              <div className="import-confirmations">
                {importPreview.summary.missingStationCallsign > 0 && (
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmImportStation}
                      onChange={(event) => setConfirmImportStation(event.target.checked)}
                    />
                    <span>{interpolate(t.importConfirmStation, { callsign: state?.station.callsign ?? '' })}</span>
                  </label>
                )}
                {importPreview.summary.missingMyGrid > 0 && (
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmImportGrid}
                      onChange={(event) => setConfirmImportGrid(event.target.checked)}
                    />
                    <span>{interpolate(t.importConfirmGrid, { grid: state?.station.grid ?? '' })}</span>
                  </label>
                )}
              </div>
            )}
            {Object.keys(importPreview.summary.issueCounts).length > 0 && (
              <div className="import-issues">
                {(Object.entries(importPreview.summary.issueCounts) as Array<[ImportIssue, number]>).map(([issue, count]) => (
                  count > 0 && <span key={issue}>{t.importIssues[issue]} · {count}</span>
                ))}
              </div>
            )}
            <div className="import-preview-list">
              {importPreview.summary.rows.slice(0, 12).map((row) => (
                <div className="import-preview-row" key={`${row.sourceIndex}-${row.callsign ?? 'invalid'}`}>
                  <span className="import-preview-call">{row.callsign ?? '-'}</span>
                  <span>{row.startTime ? new Date(row.startTime).toISOString().slice(5, 16).replace('T', ' ') : '-'}</span>
                  <span>{row.mode ?? '-'} {row.band ?? ''}</span>
                  <span className={`status status-${row.status === 'ready' ? 'included' : row.status === 'rejected' ? 'excluded' : 'review'}`}>
                    {t.importStatus[row.status]}
                  </span>
                </div>
              ))}
            </div>
            <footer className="import-dialog-footer">
              <button
                type="button"
                className="button button-sm button-light"
                disabled={busy}
                onClick={() => { void cancelImport(); }}
              >{t.importCancel}</button>
              <button
                type="button"
                className="button button-sm button-solid button-primary"
                disabled={busy
                  || importPreview.summary.importable === 0
                  || (importPreview.summary.missingStationCallsign > 0 && !confirmImportStation)
                  || (importPreview.summary.missingMyGrid > 0 && !confirmImportGrid)}
                onClick={() => { void commitImport(); }}
              >{interpolate(t.importCommit, { count: importPreview.summary.importable })}</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

function stateHealth(value: string | undefined): 'healthy' | 'degraded' | 'unknown' {
  if (value === 'healthy' || value === 'degraded') return value;
  return 'unknown';
}
