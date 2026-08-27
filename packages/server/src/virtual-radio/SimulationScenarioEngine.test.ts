import { describe, expect, it } from 'vitest';
import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';
import { BUILTIN_PLUGINS, BUILTIN_WW_DIGI_PLUGIN_NAME } from '@tx5dr/builtin-plugins';
import { SimulationScenarioEngine } from './SimulationScenarioEngine.js';

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
    const ambient = BUILTIN_PLUGINS
      .find((plugin) => plugin.definition.name === BUILTIN_WW_DIGI_PLUGIN_NAME)!
      .definition.simulationScenarios!
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
});
