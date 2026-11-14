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
  // RTTY keyboard QSOs. A message is one complete transmission; patterns tolerate
  // the free text and repetition operators use, but require the essential tokens.
  {
    id: 'rtty-answering', modes: ['RTTY'], initialState: 'idle',
    states: {
      idle: { rules: [
        { pattern: '(?:.* )?CQ(?: .*)? DE (?<operatorCallsign>[A-Z0-9/]+)(?: [A-Z0-9/ ]+)? K',
          choices: [{ reply: '{{operatorCallsign}} DE {{peerCallsign}} {{peerCallsign}} K', nextState: 'await-report' }] },
      ] },
      'await-report': {
        // Both exchange orders are common: "PEER DE OP 599 ..." and "PEER UR 599 ... DE OP".
        rules: [
          { pattern: '(?:.* )?{{peerCallsign}} DE (?<operatorCallsign>[A-Z0-9/]+) .*\\b5[0-9N][9N]\\b.*',
            choices: [{ reply: '{{operatorCallsign}} DE {{peerCallsign}} R TU UR 599 599 K', nextState: 'await-final' }] },
          { pattern: '(?:.* )?{{peerCallsign}} (?:.* )?5[0-9N][9N](?: .*)? DE (?<operatorCallsign>[A-Z0-9/]+)(?: .*)?',
            choices: [{ reply: '{{operatorCallsign}} DE {{peerCallsign}} R TU UR 599 599 K', nextState: 'await-final' }] },
        ],
        timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }],
      },
      'await-final': {
        rules: [{ pattern: '(?:.* )?{{peerCallsign}} .*\\b73\\b.*',
          choices: [{ reply: '{{operatorCallsign}} TU 73 DE {{peerCallsign}} SK', nextState: 'done' }] }],
        timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }],
      },
      done: {},
    },
  },
  {
    id: 'rtty-calling', modes: ['RTTY'], initialState: 'calling',
    states: {
      calling: {
        rules: [{ pattern: '(?:.* )?{{peerCallsign}} DE (?<operatorCallsign>[A-Z0-9/]+)(?: [A-Z0-9/ ]+)? K',
          choices: [{ reply: '{{operatorCallsign}} DE {{peerCallsign}} UR 599 599 K', nextState: 'await-report' }] }],
        timeouts: [{ afterReceiveCycles: 1, choices: [{ reply: 'CQ CQ CQ DE {{peerCallsign}} {{peerCallsign}} K' }] }],
      },
      'await-report': {
        rules: [
          { pattern: '(?:.* )?{{peerCallsign}} DE (?<operatorCallsign>[A-Z0-9/]+) .*\\b5[0-9N][9N]\\b.*',
            choices: [{ reply: '{{operatorCallsign}} TU 73 DE {{peerCallsign}} SK', nextState: 'done' }] },
          { pattern: '(?:.* )?{{peerCallsign}} (?:.* )?5[0-9N][9N](?: .*)? DE (?<operatorCallsign>[A-Z0-9/]+)(?: .*)?',
            choices: [{ reply: '{{operatorCallsign}} TU 73 DE {{peerCallsign}} SK', nextState: 'done' }] },
        ],
        timeouts: [{ afterReceiveCycles: 2, choices: [{ repeatLast: true }] }],
      },
      done: {},
    },
  },
  { id: 'rtty-silence', modes: ['RTTY'], initialState: 'silent', states: { silent: {} } },
];
