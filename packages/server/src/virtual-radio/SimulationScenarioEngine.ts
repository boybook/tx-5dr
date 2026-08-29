import type {
  SimulationPeerIdentity,
  SimulationScenarioChoice,
  SimulationScenarioDescriptor,
  SimulationScenarioRule,
} from '@tx5dr/plugin-api';

export interface SimulationPeerDefinition {
  id: string;
  callsign: string;
  grid: string;
  audioFrequencyHz: number;
  scenario: SimulationScenarioDescriptor;
  identityPool?: SimulationPeerIdentity[];
}

export interface SimulationDecodedMessage {
  text: string;
  audioFrequencyHz: number;
  sourcePeerId?: string;
}

export interface SimulationObservationOptions {
  /** Advance peer timeouts once for this receive cycle. */
  advanceReceiveCycle?: boolean;
}

export interface SimulationReplyDecision {
  peerId: string;
  text: string;
  audioFrequencyHz: number;
  delayCycles: number;
}

export interface SimulationScenarioTraceEvent {
  peerId: string;
  scenarioId: string;
  state: string;
  kind: 'matched' | 'timeout' | 'choice' | 'transition' | 'identity' | 'complete';
  data?: Record<string, unknown>;
}

interface PeerRuntime {
  definition: SimulationPeerDefinition;
  identity: SimulationPeerIdentity;
  identities: SimulationPeerIdentity[];
  identityIndex: number;
  state: string;
  quietReceiveCycles: number;
  lastReceived?: string;
  lastReceivedFrequencyHz?: number;
  lastSent?: string;
  lastCaptures: Record<string, string>;
  complete: boolean;
  random: () => number;
}

interface PeerIdentityCandidate {
  peer: PeerRuntime;
  identity: SimulationPeerIdentity;
  identityIndex: number;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMessage(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

function compileRule(rule: SimulationScenarioRule, identity: SimulationPeerIdentity): RegExp {
  const pattern = rule.pattern
    .replaceAll('{{peerCallsign}}', escapeRegExp(identity.callsign))
    .replaceAll('{{peerGrid}}', escapeRegExp(identity.grid));
  return new RegExp(`^(?:${pattern})$`, 'i');
}

export class SimulationScenarioEngine {
  private readonly peers: PeerRuntime[];
  private readonly identityOwners = new Map<string, string>();
  private readonly peersById = new Map<string, PeerRuntime>();
  private readonly identityCandidates = new Map<string, PeerIdentityCandidate[]>();
  private readonly identityAffinity = new Map<string, string>();

  constructor(
    sessionSeed: string | number,
    definitions: SimulationPeerDefinition[],
    private readonly trace?: (event: SimulationScenarioTraceEvent) => void,
  ) {
    this.peers = definitions.map((definition) => {
      const normalizedDefinition = {
        ...definition,
        callsign: normalizeMessage(definition.callsign),
        grid: normalizeMessage(definition.grid),
      };
      const identities = (definition.identityPool?.length
        ? definition.identityPool
        : [{ callsign: normalizedDefinition.callsign, grid: normalizedDefinition.grid }])
        .map((identity) => ({
          callsign: normalizeMessage(identity.callsign),
          grid: normalizeMessage(identity.grid),
        }));
      const preferredIndex = hashSeed(`${String(sessionSeed)}\u0000identity\u0000${definition.id}`) % identities.length;
      const identityIndex = this.findAvailableIdentityIndex(identities, preferredIndex);
      const identity = identities[identityIndex]!;
      this.identityOwners.set(identity.callsign, definition.id);
      return {
        definition: normalizedDefinition,
        identity,
        identities,
        identityIndex,
        state: definition.scenario.initialState,
        quietReceiveCycles: 0,
        complete: false,
        lastCaptures: {},
        random: seededRandom(hashSeed(`${String(sessionSeed)}\u0000${definition.id}`)),
      };
    });
    for (const peer of this.peers) {
      this.peersById.set(peer.definition.id, peer);
      this.identityAffinity.set(peer.identity.callsign, peer.definition.id);
      peer.identities.forEach((identity, identityIndex) => {
        const candidates = this.identityCandidates.get(identity.callsign) ?? [];
        candidates.push({ peer, identity, identityIndex });
        this.identityCandidates.set(identity.callsign, candidates);
      });
    }
  }

  observe(
    messages: SimulationDecodedMessage[],
    options: SimulationObservationOptions = {},
  ): SimulationReplyDecision[] {
    const advanceReceiveCycle = options.advanceReceiveCycle ?? true;
    const ordered = [...messages].sort((left, right) => (
      left.audioFrequencyHz - right.audioFrequencyHz || left.text.localeCompare(right.text)
    ));
    this.reactivateAddressedPeers(ordered);
    const replies: SimulationReplyDecision[] = [];
    for (const peer of this.peers) {
      if (peer.complete) continue;
      const state = peer.definition.scenario.states[peer.state]!;
      let matched = false;
      const rules = [
        ...(peer.definition.scenario.globalRules ?? []).map((rule) => ({ rule, scope: 'global' as const })),
        ...(state.rules ?? []).map((rule) => ({ rule, scope: 'state' as const })),
      ];
      for (const { rule, scope } of rules) {
        const matcher = compileRule(rule, peer.identity);
        const selected = ordered.find((message) => (
          message.sourcePeerId !== peer.definition.id && matcher.test(normalizeMessage(message.text))
        ));
        if (!selected) continue;
        const match = matcher.exec(normalizeMessage(selected.text));
        matched = true;
        peer.quietReceiveCycles = 0;
        peer.lastReceived = normalizeMessage(selected.text);
        peer.lastReceivedFrequencyHz = selected.audioFrequencyHz;
        peer.lastCaptures = { ...(match?.groups ?? {}) };
        this.emitTrace(peer, 'matched', { text: peer.lastReceived, pattern: rule.pattern, scope });
        this.applyChoice(peer, rule.choices, selected.audioFrequencyHz, match?.groups ?? {}, replies);
        break;
      }
      if (matched) continue;

      if (!advanceReceiveCycle) continue;
      peer.quietReceiveCycles += 1;
      const timeout = [...(state.timeouts ?? [])]
        .sort((left, right) => left.afterReceiveCycles - right.afterReceiveCycles)
        .find((candidate) => peer.quietReceiveCycles >= candidate.afterReceiveCycles);
      if (timeout) {
        this.emitTrace(peer, 'timeout', { receiveCycles: peer.quietReceiveCycles });
        peer.quietReceiveCycles = 0;
        this.applyChoice(
          peer,
          timeout.choices,
          peer.lastReceivedFrequencyHz ?? peer.definition.audioFrequencyHz,
          {},
          replies,
        );
      }
    }
    return replies;
  }

  getSnapshots(): Array<{
    peerId: string;
    scenarioId: string;
    callsign: string;
    grid: string;
    state: string;
    complete: boolean;
  }> {
    return this.peers.map((peer) => ({
      peerId: peer.definition.id,
      scenarioId: peer.definition.scenario.id,
      callsign: peer.identity.callsign,
      grid: peer.identity.grid,
      state: peer.state,
      complete: peer.complete,
    }));
  }

  private applyChoice(
    peer: PeerRuntime,
    choices: SimulationScenarioChoice[],
    receivedFrequencyHz: number,
    captures: Record<string, string>,
    replies: SimulationReplyDecision[],
  ): void {
    const choice = this.choose(peer, choices);
    this.emitTrace(peer, 'choice', {
      choice: choices.indexOf(choice),
      weight: choice.weight ?? 1,
      action: choice.reply ? 'reply' : choice.repeatLast ? 'repeat-last' : choice.silence ? 'silence' : 'complete',
    });

    let replyText: string | undefined;
    if (choice.reply) {
      replyText = this.renderTemplate(choice.reply, peer, { ...peer.lastCaptures, ...captures });
    } else if (choice.repeatLast) {
      replyText = peer.lastSent;
    }
    if (replyText) {
      peer.lastSent = normalizeMessage(replyText);
      replies.push({
        peerId: peer.definition.id,
        text: peer.lastSent,
        audioFrequencyHz: choice.replyFrequency === 'peer'
          ? peer.definition.audioFrequencyHz
          : receivedFrequencyHz > 0 ? receivedFrequencyHz : peer.definition.audioFrequencyHz,
        delayCycles: choice.delayCycles ?? 1,
      });
    }
    if (choice.complete) {
      peer.complete = true;
      this.identityOwners.delete(peer.identity.callsign);
      this.emitTrace(peer, 'complete');
    }
    if (choice.nextState && choice.nextState !== peer.state) {
      const previous = peer.state;
      peer.state = choice.nextState;
      peer.quietReceiveCycles = 0;
      this.emitTrace(peer, 'transition', { previous, next: peer.state });
    }
    if (choice.advanceIdentity && !peer.complete) this.advanceIdentity(peer);
  }

  private choose(peer: PeerRuntime, choices: SimulationScenarioChoice[]): SimulationScenarioChoice {
    const total = choices.reduce((sum, choice) => sum + (choice.weight ?? 1), 0);
    let selected = peer.random() * total;
    for (const choice of choices) {
      selected -= choice.weight ?? 1;
      if (selected < 0) return choice;
    }
    return choices[choices.length - 1]!;
  }

  private renderTemplate(template: string, peer: PeerRuntime, captures: Record<string, string>): string {
    const values: Record<string, string> = {
      peerCallsign: peer.identity.callsign,
      peerGrid: peer.identity.grid,
      lastReceived: peer.lastReceived ?? '',
      lastSent: peer.lastSent ?? '',
      ...captures,
    };
    return template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_whole, key: string) => values[key] ?? '');
  }

  private emitTrace(peer: PeerRuntime, kind: SimulationScenarioTraceEvent['kind'], data?: Record<string, unknown>): void {
    this.trace?.({
      peerId: peer.definition.id,
      scenarioId: peer.definition.scenario.id,
      state: peer.state,
      kind,
      data: { callsign: peer.identity.callsign, grid: peer.identity.grid, ...data },
    });
  }

  private findAvailableIdentityIndex(identities: SimulationPeerIdentity[], startIndex: number): number {
    for (let offset = 0; offset < identities.length; offset += 1) {
      const index = (startIndex + offset) % identities.length;
      if (!this.identityOwners.has(identities[index]!.callsign)) return index;
    }
    return startIndex;
  }

  private reactivateAddressedPeers(messages: SimulationDecodedMessage[]): void {
    const addressed = new Map<string, SimulationDecodedMessage>();
    for (const message of messages) {
      for (const token of this.messageIdentityTokens(message.text)) {
        const candidates = this.identityCandidates.get(token);
        if (!candidates || addressed.has(token)) continue;
        if (candidates.some((candidate) => (
          message.sourcePeerId !== candidate.peer.definition.id
          && this.matchesRestartRule(candidate.peer, candidate.identity, message.text)
        ))) {
          addressed.set(token, message);
        }
      }
    }
    if (addressed.size === 0) return;

    const reservedPeerIds = new Set<string>();
    for (const callsign of addressed.keys()) {
      const owner = this.identityOwners.get(callsign);
      if (owner) reservedPeerIds.add(owner);
    }
    const claimedPeerIds = new Set<string>();

    for (const [callsign, message] of addressed) {
      const ownerId = this.identityOwners.get(callsign);
      if (ownerId) {
        const owner = this.peersById.get(ownerId);
        if (owner
            && message.sourcePeerId !== owner.definition.id
            && this.canRestartCurrentIdentity(owner, message.text)
            && this.matchesRestartRule(owner, owner.identity, message.text)) {
          this.assignIdentity(owner, owner.identity, owner.identityIndex, 'addressed-restart');
          claimedPeerIds.add(owner.definition.id);
        }
        continue;
      }

      const eligible = (this.identityCandidates.get(callsign) ?? []).filter((candidate) => (
        message.sourcePeerId !== candidate.peer.definition.id
        && !reservedPeerIds.has(candidate.peer.definition.id)
        && !claimedPeerIds.has(candidate.peer.definition.id)
        && this.canLoadDormantIdentity(candidate.peer)
        && this.matchesRestartRule(candidate.peer, candidate.identity, message.text)
      ));
      if (eligible.length === 0) continue;
      const preferredPeerId = this.identityAffinity.get(callsign);
      const selected = eligible.find((candidate) => candidate.peer.definition.id === preferredPeerId)
        ?? eligible[0]!;
      this.assignIdentity(selected.peer, selected.identity, selected.identityIndex, 'addressed-reactivation');
      claimedPeerIds.add(selected.peer.definition.id);
    }
  }

  private messageIdentityTokens(message: string): string[] {
    return normalizeMessage(message)
      .split(' ')
      .map((token) => token.replace(/^<|>$/g, ''))
      .filter((token, index, tokens) => this.identityCandidates.has(token) && tokens.indexOf(token) === index);
  }

  private matchesRestartRule(
    peer: PeerRuntime,
    identity: SimulationPeerIdentity,
    message: string,
  ): boolean {
    if (!peer.definition.scenario.addressedRestart) return false;
    const initial = peer.definition.scenario.states[peer.definition.scenario.initialState]!;
    const rules = [
      ...(peer.definition.scenario.globalRules ?? []),
      ...(initial.rules ?? []),
    ].filter((rule) => rule.pattern.includes('{{peerCallsign}}'));
    const normalized = normalizeMessage(message);
    return rules.some((rule) => compileRule(rule, identity).test(normalized));
  }

  private canRestartCurrentIdentity(peer: PeerRuntime, message: string): boolean {
    const restart = peer.definition.scenario.addressedRestart;
    if (!restart) return false;
    if (peer.complete) return restart.restartCompleted === true;
    if (this.matchesCurrentRule(peer, message)) return false;
    return restart.reclaimableStates.includes(peer.state);
  }

  private canLoadDormantIdentity(peer: PeerRuntime): boolean {
    const restart = peer.definition.scenario.addressedRestart;
    if (!restart) return false;
    return (peer.complete && restart.restartCompleted === true)
      || restart.reclaimableStates.includes(peer.state);
  }

  private matchesCurrentRule(peer: PeerRuntime, message: string): boolean {
    const state = peer.definition.scenario.states[peer.state]!;
    const rules = [...(peer.definition.scenario.globalRules ?? []), ...(state.rules ?? [])];
    const normalized = normalizeMessage(message);
    return rules.some((rule) => compileRule(rule, peer.identity).test(normalized));
  }

  private assignIdentity(
    peer: PeerRuntime,
    identity: SimulationPeerIdentity,
    identityIndex: number,
    reason: 'addressed-restart' | 'addressed-reactivation',
  ): void {
    const previous = peer.identity;
    if (this.identityOwners.get(previous.callsign) === peer.definition.id) {
      this.identityOwners.delete(previous.callsign);
    }
    this.identityAffinity.set(previous.callsign, peer.definition.id);
    peer.identity = identity;
    peer.identityIndex = identityIndex;
    peer.state = peer.definition.scenario.initialState;
    peer.quietReceiveCycles = 0;
    peer.lastReceived = undefined;
    peer.lastReceivedFrequencyHz = undefined;
    peer.lastSent = undefined;
    peer.lastCaptures = {};
    peer.complete = false;
    this.identityOwners.set(identity.callsign, peer.definition.id);
    this.identityAffinity.set(identity.callsign, peer.definition.id);
    this.emitTrace(peer, 'identity', {
      reason,
      previousCallsign: previous.callsign,
      previousGrid: previous.grid,
    });
  }

  private advanceIdentity(peer: PeerRuntime): void {
    if (peer.identities.length < 2) return;
    const previous = peer.identity;
    this.identityOwners.delete(previous.callsign);
    this.identityAffinity.set(previous.callsign, peer.definition.id);
    const nextIndex = this.findAvailableIdentityIndex(
      peer.identities,
      (peer.identityIndex + 1) % peer.identities.length,
    );
    const next = peer.identities[nextIndex]!;
    if (this.identityOwners.has(next.callsign)) {
      this.identityOwners.set(previous.callsign, peer.definition.id);
      return;
    }
    peer.identityIndex = nextIndex;
    peer.identity = next;
    peer.lastReceived = undefined;
    peer.lastReceivedFrequencyHz = undefined;
    peer.lastSent = undefined;
    peer.lastCaptures = {};
    peer.quietReceiveCycles = 0;
    this.identityOwners.set(next.callsign, peer.definition.id);
    this.identityAffinity.set(next.callsign, peer.definition.id);
    this.emitTrace(peer, 'identity', {
      previousCallsign: previous.callsign,
      previousGrid: previous.grid,
    });
  }
}
