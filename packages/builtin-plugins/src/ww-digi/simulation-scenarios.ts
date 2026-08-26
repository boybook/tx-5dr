import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';

const GRID_MESSAGE = '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) (?<operatorGrid>[A-R]{2}[0-9]{2})';
const FINAL_MESSAGE = '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) RR73';
const SEVENTY_THREE_MESSAGE = '{{peerCallsign}} (?<operatorCallsign>[A-Z0-9/]+) 73';
const R_GRID_REPLY = '{{operatorCallsign}} {{peerCallsign}} R {{peerGrid}}';

function finalScenario(id: string, finalReply?: 'RRR' | 'RR73' | '73'): SimulationScenarioDescriptor {
  return {
    id,
    modes: ['FT8', 'FT4'],
    initialState: 'await-grid',
    states: {
      'await-grid': {
        rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: R_GRID_REPLY, nextState: 'await-final' }] }],
      },
      'await-final': {
        rules: [{
          pattern: FINAL_MESSAGE,
          choices: finalReply
            ? [{ reply: `{{operatorCallsign}} {{peerCallsign}} ${finalReply}`, nextState: 'done' }]
            : [{ complete: true }],
        }],
      },
      done: {},
    },
  };
}

export const wwDigiSimulationScenarios: SimulationScenarioDescriptor[] = [
  finalScenario('standard'),
  finalScenario('final-rrr', 'RRR'),
  finalScenario('final-rr73', 'RR73'),
  finalScenario('final-73', '73'),
  {
    id: 'ambient-band', modes: ['FT8', 'FT4'], initialState: 'idle', states: {
      idle: {
        rules: [{
          pattern: 'CQ WW (?<contactCallsign>[A-Z0-9/]+) (?<contactGrid>[A-R]{2}[0-9]{2})',
          choices: [
            {
              weight: 3,
              reply: '{{contactCallsign}} {{peerCallsign}} {{peerGrid}}',
              replyFrequency: 'peer',
              nextState: 'await-r-grid',
            },
            { weight: 7, silence: true },
          ],
        }],
        timeouts: [{ afterReceiveCycles: 2, choices: [
          { weight: 1, reply: 'CQ WW {{peerCallsign}} {{peerGrid}}', replyFrequency: 'peer', nextState: 'calling' },
          { weight: 7, silence: true },
        ] }],
      },
      calling: {
        rules: [{
          pattern: '{{peerCallsign}} (?<contactCallsign>[A-Z0-9/]+) (?<contactGrid>[A-R]{2}[0-9]{2})',
          choices: [{
            reply: '{{contactCallsign}} {{peerCallsign}} R {{peerGrid}}',
            replyFrequency: 'peer',
            nextState: 'await-final',
          }],
        }],
        timeouts: [{ afterReceiveCycles: 2, choices: [
          { weight: 1, repeatLast: true },
          { weight: 2, silence: true },
        ] }],
      },
      'await-r-grid': {
        rules: [{
          pattern: '{{peerCallsign}} (?<contactCallsign>[A-Z0-9/]+) R [A-R]{2}[0-9]{2}',
          choices: [{
            reply: '{{contactCallsign}} {{peerCallsign}} RR73',
            replyFrequency: 'peer',
            nextState: 'idle',
          }],
        }],
        timeouts: [{ afterReceiveCycles: 3, choices: [{ silence: true, nextState: 'idle' }] }],
      },
      'await-final': {
        rules: [{
          pattern: '{{peerCallsign}} [A-Z0-9/]+ (?:RRR|RR73|73)',
          choices: [{ silence: true, nextState: 'idle' }],
        }],
        timeouts: [{ afterReceiveCycles: 3, choices: [{ silence: true, nextState: 'idle' }] }],
      },
    },
  },
  {
    id: 'repeat-exchange', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: R_GRID_REPLY, nextState: 'await-final' }] }] },
      'await-final': { rules: [{ pattern: FINAL_MESSAGE, choices: [{ reply: R_GRID_REPLY, nextState: 'await-repeated-final' }] }] },
      'await-repeated-final': { rules: [{ pattern: FINAL_MESSAGE, choices: [{ complete: true }] }] },
    },
  },
  {
    id: 'repeat-final-wait-73', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: R_GRID_REPLY, nextState: 'await-final' }] }] },
      'await-final': { rules: [{ pattern: FINAL_MESSAGE, choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} RR73', nextState: 'await-73' }] }] },
      'await-73': {
        rules: [{ pattern: SEVENTY_THREE_MESSAGE, choices: [{ complete: true }] }],
        timeouts: [{ afterReceiveCycles: 1, choices: [{ repeatLast: true }] }],
      },
    },
  },
  {
    id: 'delayed-reply', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ silence: true, nextState: 'delayed' }] }] },
      delayed: { timeouts: [{ afterReceiveCycles: 2, choices: [{ reply: R_GRID_REPLY, nextState: 'await-final' }] }] },
      'await-final': { rules: [{ pattern: FINAL_MESSAGE, choices: [{ complete: true }] }] },
    },
  },
  {
    id: 'timeout', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ silence: true, nextState: 'waiting' }] }] },
      waiting: { timeouts: [{ afterReceiveCycles: 3, choices: [{ complete: true }] }] },
    },
  },
  {
    id: 'permanent-silence', modes: ['FT8', 'FT4'], initialState: 'silent', states: {
      silent: { rules: [{ pattern: '.*', choices: [{ silence: true }] }] },
    },
  },
  {
    id: 'repeat-old-message', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: R_GRID_REPLY, nextState: 'await-final' }] }] },
      'await-final': { rules: [{ pattern: FINAL_MESSAGE, choices: [{ reply: R_GRID_REPLY, nextState: 'done' }] }] },
      done: {},
    },
  },
  {
    id: 'out-of-order', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': {
        rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} 73', nextState: 'done' }] }],
      },
      done: {},
    },
  },
  {
    id: 'wrong-target', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: 'N0CALL {{peerCallsign}} R {{peerGrid}}', nextState: 'done' }] }] },
      done: {},
    },
  },
  {
    id: 'unrelated-callsign', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: 'CQ N0CALL AA00', nextState: 'done' }] }] },
      done: {},
    },
  },
  {
    id: 'missing-grid', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': {
        rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}}', nextState: 'done' }] }],
      },
      done: {},
    },
  },
  {
    id: 'invalid-grid', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: '{{operatorCallsign}} {{peerCallsign}} ZZ00', nextState: 'done' }] }] },
      done: {},
    },
  },
  {
    id: 'alternate-text', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': { rules: [{ pattern: GRID_MESSAGE, choices: [{ reply: 'NOGRID', nextState: 'done' }] }] },
      done: {},
    },
  },
  {
    id: 'seeded-random', modes: ['FT8', 'FT4'], initialState: 'await-grid', states: {
      'await-grid': {
        rules: [{ pattern: GRID_MESSAGE, choices: [
          { weight: 6, reply: R_GRID_REPLY, nextState: 'await-final' },
          { weight: 2, silence: true, nextState: 'delayed' },
          { weight: 1, reply: 'N0CALL {{peerCallsign}} R {{peerGrid}}', nextState: 'done' },
        ] }],
      },
      delayed: { timeouts: [{ afterReceiveCycles: 1, choices: [
        { weight: 3, reply: R_GRID_REPLY, nextState: 'await-final' },
        { weight: 1, silence: true },
      ] }] },
      'await-final': { rules: [{ pattern: FINAL_MESSAGE, choices: [
        { weight: 5, complete: true },
        { weight: 2, reply: '{{operatorCallsign}} {{peerCallsign}} RR73', nextState: 'await-73' },
        { weight: 1, reply: R_GRID_REPLY },
      ] }] },
      'await-73': {
        rules: [{ pattern: SEVENTY_THREE_MESSAGE, choices: [{ complete: true }] }],
        timeouts: [{ afterReceiveCycles: 1, choices: [{ repeatLast: true }] }],
      },
      done: {},
    },
  },
];
