import { describe, expect, it } from 'vitest';
import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';
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
});
