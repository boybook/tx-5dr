import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';

/** Independent wire-level peer, deliberately not implemented using the station strategy. */
export const standardSimulationScenarios: SimulationScenarioDescriptor[] = [
  {
    id: 'standard', modes: ['FT8', 'FT4'], initialState: 'idle',
    states: {
      idle: { rules: [
        { pattern: 'CQ(?: [A-Z]{1,4})? (?<operatorCallsign>[A-Z0-9/]+) [A-R]{2}[0-9]{2}',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} {{peerGrid}}', nextState: 'await-report' }] },
        { pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) [A-R]{2}[0-9]{2}',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} -10', nextState: 'await-r-report' }] },
      ] },
      'await-report': { rules: [
        { pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) [+-][0-9]{2}',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} R-10', nextState: 'await-final' }] },
      ], timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }] },
      'await-r-report': { rules: [
        { pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) R[+-][0-9]{2}',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} RR73', nextState: 'done' }] },
      ], timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }] },
      'await-final': { rules: [
        { pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) (?:RRR|RR73)',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} 73', nextState: 'done' }] },
      ], timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }] },
      done: {},
    },
  },
  {
    id: 'calling', modes: ['FT8', 'FT4'], initialState: 'calling',
    states: {
      calling: {
        rules: [{ pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) [A-R]{2}[0-9]{2}',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} -10', nextState: 'await-r-report' }] }],
        timeouts: [{ afterReceiveCycles: 1, choices: [{ reply: 'CQ {{peerCallsign}} {{peerGrid}}' }] }],
      },
      'await-r-report': {
        rules: [{ pattern: '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) R[+-][0-9]{2}',
          choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} RR73', nextState: 'done' }] }],
        timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }],
      },
      done: {},
    },
  },
  { id: 'silence', modes: ['FT8', 'FT4'], initialState: 'silent', states: { silent: {} } },
];
