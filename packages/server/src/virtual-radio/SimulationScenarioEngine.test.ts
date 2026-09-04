import { describe, expect, it } from 'vitest';
import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';
import { SimulationScenarioEngine } from './SimulationScenarioEngine.js';
import { wwDigiSimulationScenarios } from './testFixtures/ww-digi-simulation-scenarios.js';

const scenario: SimulationScenarioDescriptor = {
  id: 'test',
  modes: ['FT8'],
  initialState: 'waiting',
  states: {
    waiting: {
      rules: [{
        pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9]+) (?<operatorGrid>[A-R]{2}[0-9]{2})',
        choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} R {{peerGrid}}', nextState: 'final' }],
      }],
    },
    final: {
      timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }],
    },
  },
};

describe('SimulationScenarioEngine', () => {
  it('matches a peer, renders captures, and advances state', () => {
    const engine = new SimulationScenarioEngine('seed', [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_500, scenario,
    }]);
    expect(engine.observe([{ text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_620 }])).toEqual([{
      peerId: 'peer-1', text: 'BG5DRB JA1AAA R PM95', audioFrequencyHz: 1_620, delayCycles: 1,
    }]);
    expect(engine.getSnapshots()[0]).toMatchObject({ state: 'final', complete: false });
  });

  it('uses a stable peer-local random stream', () => {
    const randomScenario: SimulationScenarioDescriptor = {
      ...scenario,
      states: {
        waiting: { rules: [{ pattern: 'PING', choices: [
          { weight: 1, reply: 'ONE' },
          { weight: 1, reply: 'TWO' },
        ] }] },
      },
    };
    const run = () => new SimulationScenarioEngine(42, [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_500, scenario: randomScenario,
    }]).observe([{ text: 'PING', audioFrequencyHz: 1_500 }]);
    expect(run()).toEqual(run());
  });

  it('fires a timeout and repeats the previous response', () => {
    const engine = new SimulationScenarioEngine('seed', [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_500, scenario,
    }]);
    engine.observe([{ text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_500 }]);
    expect(engine.observe([])).toEqual([]);
    expect(engine.observe([])[0]).toEqual({
      peerId: 'peer-1',
      text: 'BG5DRB JA1AAA R PM95',
      audioFrequencyHz: 1_500,
      delayCycles: 1,
    });
  });

  it('retains named captures for a delayed timeout reply', () => {
    const delayed: SimulationScenarioDescriptor = {
      id: 'delayed', modes: ['FT8'], initialState: 'waiting', states: {
        waiting: { rules: [{
          pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9]+) [A-R]{2}[0-9]{2}',
          choices: [{ silence: true, nextState: 'delay' }],
        }] },
        delay: { timeouts: [{
          afterReceiveCycles: 1,
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} R {{peerGrid}}' }],
        }] },
      },
    };
    const engine = new SimulationScenarioEngine('seed', [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_500, scenario: delayed,
    }]);
    expect(engine.observe([{ text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_725 }])).toEqual([]);
    expect(engine.observe([])[0]).toEqual({
      peerId: 'peer-1',
      text: 'BG5DRB JA1AAA R PM95',
      audioFrequencyHz: 1_725,
      delayCycles: 1,
    });
  });

  it('advances timeouts only on an authoritative receive-cycle tick', () => {
    const autonomous: SimulationScenarioDescriptor = {
      id: 'autonomous', modes: ['FT8'], initialState: 'idle', states: {
        idle: { timeouts: [{ afterReceiveCycles: 1, choices: [{ reply: 'CQ TEST' }] }] },
      },
    };
    const engine = new SimulationScenarioEngine('seed', [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_500, scenario: autonomous,
    }]);

    expect(engine.observe([], { advanceReceiveCycle: false })).toEqual([]);
    expect(engine.observe([], { advanceReceiveCycle: true })).toEqual([{
      peerId: 'peer-1', text: 'CQ TEST', audioFrequencyHz: 1_500, delayCycles: 1,
    }]);
  });

  it('does not let a peer hear itself and can reply on its configured frequency', () => {
    const listener: SimulationScenarioDescriptor = {
      id: 'listener', modes: ['FT8'], initialState: 'idle', states: {
        idle: { rules: [{
          pattern: 'CQ TEST',
          choices: [{ reply: 'ANSWER', replyFrequency: 'peer' }],
        }] },
      },
    };
    const engine = new SimulationScenarioEngine('seed', [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_700, scenario: listener,
    }]);

    expect(engine.observe([{
      text: 'CQ TEST', audioFrequencyHz: 1_200, sourcePeerId: 'peer-1',
    }])).toEqual([]);
    expect(engine.observe([{
      text: 'CQ TEST', audioFrequencyHz: 1_200, sourcePeerId: 'peer-2',
    }])).toEqual([{
      peerId: 'peer-1', text: 'ANSWER', audioFrequencyHz: 1_700, delayCycles: 1,
    }]);
  });

  it('lets an ambient WW Digi peer infer directed exchanges from any state', () => {
    const ambient = wwDigiSimulationScenarios
      .find((candidate) => candidate.id === 'ambient-band')!;
    const engine = new SimulationScenarioEngine('seed', [{
      id: 'ambient-1', callsign: 'W1VRB', grid: 'FN42', audioFrequencyHz: 1_700, scenario: ambient,
    }]);

    expect(engine.observe([{ text: 'W1VRB BG0VRT NN00', audioFrequencyHz: 1_400 }])).toEqual([{
      peerId: 'ambient-1', text: 'BG0VRT W1VRB R FN42', audioFrequencyHz: 1_700, delayCycles: 1,
    }]);
    expect(engine.getSnapshots()[0]).toMatchObject({ state: 'await-final' });

    expect(engine.observe([{ text: 'W1VRB BG0VRT NN00', audioFrequencyHz: 1_400 }])).toHaveLength(1);
    expect(engine.observe([{ text: 'W1VRB BG0VRT RR73', audioFrequencyHz: 1_400 }])).toEqual([]);
    expect(engine.getSnapshots()[0]).toMatchObject({ state: 'idle' });

    expect(engine.observe([{ text: 'W1VRB BG0VRT R NN00', audioFrequencyHz: 1_400 }])).toEqual([{
      peerId: 'ambient-1', text: 'BG0VRT W1VRB RR73', audioFrequencyHz: 1_700, delayCycles: 1,
    }]);
  });

  it('lets the ambient band hear standard and contest CQ forms', () => {
    const ambient = wwDigiSimulationScenarios
      .find((candidate) => candidate.id === 'ambient-band')!;
    const matched: string[] = [];
    const create = (id: string) => new SimulationScenarioEngine(id, [{
      id: 'ambient-1', callsign: 'W1VRB', grid: 'FN42', audioFrequencyHz: 1_700, scenario: ambient,
    }], (event) => {
      if (event.kind === 'matched') matched.push(String(event.data?.text));
    });

    create('standard-cq').observe([{ text: 'CQ BG0VRT NN00', audioFrequencyHz: 1_400 }]);
    create('contest-cq').observe([{ text: 'CQ WW BG0VRT NN00', audioFrequencyHz: 1_400 }]);
    expect(matched).toEqual(['CQ BG0VRT NN00', 'CQ WW BG0VRT NN00']);
  });

  it('rotates pooled identities deterministically without concurrent duplicates', () => {
    const identityPool = [
      { callsign: 'K1VAA', grid: 'FN31' },
      { callsign: 'JA1VAA', grid: 'PM95' },
      { callsign: 'DL1VAA', grid: 'JO62' },
      { callsign: 'VK2VAA', grid: 'QF56' },
    ];
    const rotating: SimulationScenarioDescriptor = {
      id: 'rotating', modes: ['FT8'], initialState: 'idle', identityPool,
      states: { idle: { rules: [{
        pattern: 'PING',
        choices: [{ reply: '{{peerCallsign}} {{peerGrid}}', advanceIdentity: true }],
      }] } },
    };
    const create = () => new SimulationScenarioEngine('stable-seed', [
      { id: 'peer-1', callsign: 'N0BASE', grid: 'DM79', audioFrequencyHz: 1_200, scenario: rotating, identityPool },
      { id: 'peer-2', callsign: 'N1BASE', grid: 'FN42', audioFrequencyHz: 1_800, scenario: rotating, identityPool },
    ]);
    const first = create();
    const second = create();

    for (let cycle = 0; cycle < 12; cycle += 1) {
      expect(first.observe([{ text: 'PING', audioFrequencyHz: 1_500 }]))
        .toEqual(second.observe([{ text: 'PING', audioFrequencyHz: 1_500 }]));
      const snapshots = first.getSnapshots();
      expect(new Set(snapshots.map((peer) => peer.callsign)).size).toBe(2);
    }
  });

  it('reactivates a previous pooled identity when it is directly addressed', () => {
    const ambient = wwDigiSimulationScenarios
      .find((candidate) => candidate.id === 'ambient-band')!;
    const identityPool = [
      { callsign: 'YV5VAC', grid: 'FK62' },
      { callsign: 'YV5VAD', grid: 'FK63' },
    ];
    const engine = new SimulationScenarioEngine('addressed-restart', [{
      id: 'ambient-1', callsign: 'YV5VAC', grid: 'FK62', audioFrequencyHz: 1_700,
      scenario: ambient, identityPool,
    }]);
    const original = engine.getSnapshots()[0]!;

    expect(engine.observe([{
      text: `${original.callsign} BG0VRT R NN00`, audioFrequencyHz: 1_400,
    }])).toEqual([{
      peerId: 'ambient-1', text: `BG0VRT ${original.callsign} RR73`, audioFrequencyHz: 1_700, delayCycles: 1,
    }]);
    expect(engine.getSnapshots()[0]!.callsign).not.toBe(original.callsign);

    expect(engine.observe([{
      text: `${original.callsign} BG0VRT NN00`, audioFrequencyHz: 1_425,
    }])).toEqual([{
      peerId: 'ambient-1', text: `BG0VRT ${original.callsign} R ${original.grid}`,
      audioFrequencyHz: 1_700, delayCycles: 1,
    }]);
    expect(engine.getSnapshots()[0]).toMatchObject({ callsign: original.callsign, state: 'await-final' });
  });

  it('does not evict a busy peer to reactivate a dormant identity', () => {
    const ambient = wwDigiSimulationScenarios
      .find((candidate) => candidate.id === 'ambient-band')!;
    const identityPool = [
      { callsign: 'YV5VAC', grid: 'FK62' },
      { callsign: 'YV5VAD', grid: 'FK63' },
    ];
    const engine = new SimulationScenarioEngine('busy-peer', [{
      id: 'ambient-1', callsign: 'YV5VAC', grid: 'FK62', audioFrequencyHz: 1_700,
      scenario: ambient, identityPool,
    }]);
    const active = engine.getSnapshots()[0]!;
    const dormant = identityPool.find((identity) => identity.callsign !== active.callsign)!;

    expect(engine.observe([{
      text: `${active.callsign} BG0VRT NN00`, audioFrequencyHz: 1_400,
    }])).toHaveLength(1);
    expect(engine.getSnapshots()[0]).toMatchObject({ callsign: active.callsign, state: 'await-final' });

    expect(engine.observe([{
      text: `${dormant.callsign} BG0VRT NN00`, audioFrequencyHz: 1_425,
    }])).toEqual([]);
    expect(engine.getSnapshots()[0]).toMatchObject({ callsign: active.callsign, state: 'await-final' });
  });

  it('loads multiple addressed dormant identities into distinct idle peers in one frame', () => {
    const ambient = wwDigiSimulationScenarios
      .find((candidate) => candidate.id === 'ambient-band')!;
    const identityPool = Array.from({ length: 30 }, (_value, index) => ({
      callsign: `K1V${String(index).padStart(2, '0')}`,
      grid: `FN${String(index).padStart(2, '0')}`,
    }));
    const engine = new SimulationScenarioEngine('three-addressed', [1_000, 1_500, 2_000].map((frequency, index) => ({
      id: `ambient-${index}`, callsign: `N${index}BASE`, grid: 'DM79',
      audioFrequencyHz: frequency, scenario: ambient, identityPool,
    })));
    const activeCallsigns = new Set(engine.getSnapshots().map((peer) => peer.callsign));
    const dormant = identityPool.filter((identity) => !activeCallsigns.has(identity.callsign)).slice(0, 3);

    const replies = engine.observe(dormant.map((identity, index) => ({
      text: `${identity.callsign} BG0VRT NN00`, audioFrequencyHz: 1_400 + index * 100,
    })));
    expect(replies).toHaveLength(3);
    expect(new Set(replies.map((reply) => reply.peerId)).size).toBe(3);
    expect(replies.map((reply) => reply.text)).toEqual(expect.arrayContaining(dormant.map(
      (identity) => `BG0VRT ${identity.callsign} R ${identity.grid}`,
    )));
  });

  it('restarts an opted-in completed fixed peer when it is addressed again', () => {
    const replayable: SimulationScenarioDescriptor = {
      id: 'replayable', modes: ['FT8'], initialState: 'waiting',
      addressedRestart: { reclaimableStates: ['waiting'], restartCompleted: true },
      states: {
        waiting: { rules: [{
          pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9]+) [A-R]{2}[0-9]{2}',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} R {{peerGrid}}', nextState: 'finishing' }],
        }] },
        finishing: { rules: [{ pattern: 'FINISH', choices: [{ complete: true }] }] },
      },
    };
    const engine = new SimulationScenarioEngine('fixed-restart', [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_500, scenario: replayable,
    }]);
    const call = [{ text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_620 }];

    expect(engine.observe(call)).toHaveLength(1);
    expect(engine.observe([{ text: 'FINISH', audioFrequencyHz: 1_620 }])).toEqual([]);
    expect(engine.getSnapshots()[0]).toMatchObject({ complete: true });
    expect(engine.observe(call)).toHaveLength(1);
    expect(engine.getSnapshots()[0]).toMatchObject({ state: 'finishing', complete: false });
    expect(engine.observe([{ text: 'FINISH', audioFrequencyHz: 1_620 }])).toEqual([]);
    expect(engine.getSnapshots()[0]).toMatchObject({ complete: true });
  });

  it('lets an existing global rule handle a reclaimable state before restarting it', () => {
    const globalRecovery: SimulationScenarioDescriptor = {
      id: 'global-recovery', modes: ['FT8'], initialState: 'idle',
      addressedRestart: { reclaimableStates: ['idle', 'done'] },
      globalRules: [{ pattern: '{{peerCallsign}} AGAIN', choices: [{ repeatLast: true }] }],
      states: {
        idle: { rules: [{
          pattern: '{{peerCallsign}} START', choices: [{ reply: 'SAVED', nextState: 'done' }],
        }] },
        done: {},
      },
    };
    const engine = new SimulationScenarioEngine('global-recovery', [{
      id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', audioFrequencyHz: 1_500,
      scenario: globalRecovery,
    }]);

    expect(engine.observe([{ text: 'JA1AAA START', audioFrequencyHz: 1_620 }])[0]?.text).toBe('SAVED');
    expect(engine.getSnapshots()[0]).toMatchObject({ state: 'done' });
    expect(engine.observe([{ text: 'JA1AAA AGAIN', audioFrequencyHz: 1_620 }])[0]?.text).toBe('SAVED');
    expect(engine.getSnapshots()[0]).toMatchObject({ state: 'done' });
  });
});
