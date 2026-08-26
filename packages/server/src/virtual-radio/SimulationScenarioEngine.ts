import type {
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
}

export interface SimulationDecodedMessage {
  text: string;
  audioFrequencyHz: number;
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
  kind: 'matched' | 'timeout' | 'choice' | 'transition' | 'complete';
  data?: Record<string, unknown>;
}

interface PeerRuntime {
  definition: SimulationPeerDefinition;
  state: string;
  quietReceiveCycles: number;
  lastReceived?: string;
  lastReceivedFrequencyHz?: number;
  lastSent?: string;
  lastCaptures: Record<string, string>;
  complete: boolean;
  random: () => number;
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

function compileRule(rule: SimulationScenarioRule, peer: SimulationPeerDefinition): RegExp {
  const pattern = rule.pattern
    .replaceAll('{{peerCallsign}}', escapeRegExp(peer.callsign))
    .replaceAll('{{peerGrid}}', escapeRegExp(peer.grid));
  return new RegExp(`^(?:${pattern})$`, 'i');
}

export class SimulationScenarioEngine {
  private readonly peers: PeerRuntime[];

  constructor(
    sessionSeed: string | number,
    definitions: SimulationPeerDefinition[],
    private readonly trace?: (event: SimulationScenarioTraceEvent) => void,
  ) {
    this.peers = definitions.map((definition) => ({
      definition: {
        ...definition,
        callsign: normalizeMessage(definition.callsign),
        grid: normalizeMessage(definition.grid),
      },
      state: definition.scenario.initialState,
      quietReceiveCycles: 0,
      complete: false,
      lastCaptures: {},
      random: seededRandom(hashSeed(`${String(sessionSeed)}\u0000${definition.id}`)),
    }));
  }

  observe(messages: SimulationDecodedMessage[]): SimulationReplyDecision[] {
    const ordered = [...messages].sort((left, right) => (
      left.audioFrequencyHz - right.audioFrequencyHz || left.text.localeCompare(right.text)
    ));
    const replies: SimulationReplyDecision[] = [];
    for (const peer of this.peers) {
      if (peer.complete) continue;
      const state = peer.definition.scenario.states[peer.state]!;
      let matched = false;
      for (const rule of state.rules ?? []) {
        const matcher = compileRule(rule, peer.definition);
        const selected = ordered.find((message) => matcher.test(normalizeMessage(message.text)));
        if (!selected) continue;
        const match = matcher.exec(normalizeMessage(selected.text));
        matched = true;
        peer.quietReceiveCycles = 0;
        peer.lastReceived = normalizeMessage(selected.text);
        peer.lastReceivedFrequencyHz = selected.audioFrequencyHz;
        peer.lastCaptures = { ...(match?.groups ?? {}) };
        this.emitTrace(peer, 'matched', { text: peer.lastReceived, pattern: rule.pattern });
        this.applyChoice(peer, rule.choices, selected.audioFrequencyHz, match?.groups ?? {}, replies);
        break;
      }
      if (matched) continue;

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

  getSnapshots(): Array<{ peerId: string; scenarioId: string; state: string; complete: boolean }> {
    return this.peers.map((peer) => ({
      peerId: peer.definition.id,
      scenarioId: peer.definition.scenario.id,
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
        audioFrequencyHz: receivedFrequencyHz > 0 ? receivedFrequencyHz : peer.definition.audioFrequencyHz,
        delayCycles: choice.delayCycles ?? 1,
      });
    }
    if (choice.complete) {
      peer.complete = true;
      this.emitTrace(peer, 'complete');
    }
    if (choice.nextState && choice.nextState !== peer.state) {
      const previous = peer.state;
      peer.state = choice.nextState;
      peer.quietReceiveCycles = 0;
      this.emitTrace(peer, 'transition', { previous, next: peer.state });
    }
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
      peerCallsign: peer.definition.callsign,
      peerGrid: peer.definition.grid,
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
      data,
    });
  }
}
