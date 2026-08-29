import type {
  StrategyMessagePresentationBadge,
  StrategyMessagePresentationClass,
  StrategyMessagePresentationProjection,
  StrategyMessagePresentationTone,
  StrategyMessagePresentationTokenMatch,
} from '@tx5dr/contracts';

export interface FrameRowMessageFacts {
  isTx: boolean;
  rawText: string;
  callsign?: string;
  grid?: string;
  partition?: string;
}

export interface FrameRowLogbookPresentation {
  enabled: boolean;
  worked: boolean;
  isSpecialMessage: boolean;
  highlight?: { label: string; color: string };
}

export interface FrameRowBadgePresentation extends StrategyMessagePresentationBadge {
  color?: string;
  strategyLabel?: boolean;
}

export interface FrameRowPresentation {
  source: 'none' | 'logbook' | 'strategy';
  badges: FrameRowBadgePresentation[];
  color?: string;
  background: boolean;
  accent: boolean;
  highlightedHover: boolean;
  textDecoration?: 'line-through';
  opacity?: 'normal' | 'muted';
}

const COLOR_BY_TONE: Record<StrategyMessagePresentationTone, string> = {
  neutral: '#71717a',
  primary: '#006fee',
  secondary: '#a855f7',
  success: '#17c964',
  warning: '#f5a524',
  danger: '#f31260',
};

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim().toUpperCase();
  return result || undefined;
}

function projectionApplies(facts: FrameRowMessageFacts, projection: StrategyMessagePresentationProjection): boolean {
  if (facts.isTx) return false;
  if (projection.partitionBy === 'none') return true;
  const partition = normalized(facts.partition);
  if (!partition) return false;
  return !projection.eligiblePartitions?.length
    || projection.eligiblePartitions.some((candidate) => normalized(candidate) === partition);
}

function resolveFact(facts: FrameRowMessageFacts, fact: 'grid-field-2'): string | undefined {
  if (fact !== 'grid-field-2') return undefined;
  const field = normalized(facts.grid)?.slice(0, 2);
  return field && /^[A-R]{2}$/.test(field) ? field : undefined;
}

function mergePresentationClasses(
  classes: Array<StrategyMessagePresentationClass | undefined>,
): StrategyMessagePresentationClass | undefined {
  const resolved = classes.filter((value): value is StrategyMessagePresentationClass => Boolean(value));
  if (resolved.length === 0) return undefined;
  const merged: StrategyMessagePresentationClass = {};
  const badges: StrategyMessagePresentationBadge[] = [];
  for (const value of resolved) {
    if (value.badge) badges.push(value.badge);
    if (value.badges) badges.push(...value.badges);
    if (value.row) merged.row = value.row;
    if (value.textDecoration) merged.textDecoration = value.textDecoration;
    if (value.opacity) merged.opacity = value.opacity;
  }
  if (badges.length > 0) merged.badges = badges;
  return merged;
}

function matchesTokenRule(rawText: string, match: StrategyMessagePresentationTokenMatch): boolean {
  const tokens = rawText.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const hasConstraint = Boolean(match.firstTokenIn?.length || match.anyTokenIn?.length);
  if (!hasConstraint) return false;
  if (match.firstTokenIn?.length
      && !match.firstTokenIn.some((candidate) => normalized(candidate) === tokens[0])) return false;
  if (match.anyTokenIn?.length
      && !match.anyTokenIn.some((candidate) => tokens.includes(normalized(candidate) ?? ''))) return false;
  return true;
}

function applyConditionalEmphasis(
  rawText: string,
  presentationClass: StrategyMessagePresentationClass | undefined,
): StrategyMessagePresentationClass | undefined {
  if (!presentationClass?.emphasisWhen?.length
      || presentationClass.emphasisWhen.some((match) => matchesTokenRule(rawText, match))) {
    return presentationClass;
  }
  return {
    ...presentationClass,
    badge: undefined,
    badges: undefined,
    row: presentationClass.row ? { ...presentationClass.row, background: 'none' } : undefined,
  };
}

export function resolveStrategyPresentationClass(
  facts: FrameRowMessageFacts,
  projection?: StrategyMessagePresentationProjection,
): StrategyMessagePresentationClass | undefined {
  if (!projection || !projectionApplies(facts, projection)) return undefined;
  const subject = normalized(facts.callsign);
  if (projection.subject === 'sender-callsign' && !subject) return undefined;
  const partition = normalized(facts.partition);
  // An explicit assignment is terminal (for example, a worked contact).
  const assigned = subject ? projection.assignments.find((candidate) => (
    normalized(candidate.subject) === subject
    && (projection.partitionBy === 'none' || normalized(candidate.partition) === partition)
  )) : undefined;
  if (assigned) return applyConditionalEmphasis(facts.rawText, projection.classes[assigned.classId]);

  // Otherwise combine the base state with every matching novelty overlay.
  const presentationClasses: Array<StrategyMessagePresentationClass | undefined> = [
    projection.defaultClass
      ? applyConditionalEmphasis(facts.rawText, projection.classes[projection.defaultClass])
      : undefined,
  ];
  for (const rule of projection.noveltyRules ?? []) {
    const value = resolveFact(facts, rule.fact);
    if (!value) continue;
    const known = Object.entries(rule.knownValuesByPartition)
      .find(([key]) => normalized(key) === partition)?.[1] ?? [];
    if (!known.some((candidate) => normalized(candidate) === value)) {
      presentationClasses.push(applyConditionalEmphasis(facts.rawText, projection.classes[rule.classId]));
    }
  }
  return mergePresentationClasses(presentationClasses);
}

function strategyBadges(
  rawText: string,
  projection: StrategyMessagePresentationProjection,
  presentationClass?: StrategyMessagePresentationClass,
): FrameRowBadgePresentation[] {
  const badges = [
    ...(projection.tagRules ?? [])
      .filter((rule) => matchesTokenRule(rawText, rule.match))
      .map((rule) => rule.badge),
    ...(presentationClass?.badge ? [presentationClass.badge] : []),
    ...(presentationClass?.badges ?? []),
  ];
  const seen = new Set<string>();
  return badges.filter((badge) => {
    const key = `${badge.label}\u0000${badge.tone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((badge) => ({ ...badge, strategyLabel: true }));
}

function logbookPresentation(input: FrameRowLogbookPresentation): FrameRowPresentation {
  const highlight = input.enabled ? input.highlight : undefined;
  return {
    source: highlight || input.worked ? 'logbook' : 'none',
    badges: highlight && input.isSpecialMessage
      ? [{ label: highlight.label, tone: 'neutral', color: highlight.color }]
      : [],
    color: highlight?.color,
    background: Boolean(highlight && input.isSpecialMessage),
    accent: Boolean(highlight),
    highlightedHover: Boolean(highlight && input.isSpecialMessage),
    textDecoration: input.enabled && input.worked ? 'line-through' : undefined,
    opacity: input.enabled && input.worked ? 'muted' : undefined,
  };
}

export function resolveFrameRowPresentation(input: {
  facts: FrameRowMessageFacts;
  strategy?: StrategyMessagePresentationProjection;
  logbook: FrameRowLogbookPresentation;
}): FrameRowPresentation {
  const fallback = logbookPresentation(input.logbook);
  const projection = input.strategy;
  if (!projection || !projectionApplies(input.facts, projection)) {
    return projection?.mode === 'replace-logbook'
      ? { source: 'strategy', badges: [], background: false, accent: false, highlightedHover: false }
      : fallback;
  }

  const presentationClass = resolveStrategyPresentationClass(input.facts, projection);
  const row = presentationClass?.row;
  const strategy: FrameRowPresentation = {
    source: 'strategy',
    badges: strategyBadges(input.facts.rawText, projection, presentationClass),
    color: row ? COLOR_BY_TONE[row.tone] : undefined,
    background: row?.background === 'soft',
    accent: row?.accent === true,
    highlightedHover: row?.background === 'soft',
    textDecoration: presentationClass?.textDecoration,
    opacity: presentationClass?.opacity,
  };
  if (projection.mode === 'replace-logbook') return strategy;
  return {
    ...fallback,
    ...strategy,
    badges: [...fallback.badges, ...strategy.badges],
    color: strategy.color ?? fallback.color,
    background: strategy.background || fallback.background,
    accent: strategy.accent || fallback.accent,
    highlightedHover: strategy.highlightedHover || fallback.highlightedHover,
    textDecoration: strategy.textDecoration ?? fallback.textDecoration,
    opacity: strategy.opacity ?? fallback.opacity,
  };
}
