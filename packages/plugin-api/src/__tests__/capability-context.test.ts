import { describe, expect, it } from 'vitest';
import { definePlugin } from '../definition.js';

describe('capability-derived plugin contexts', () => {
  it('keeps speculative strategy factories free of command capabilities', () => {
    definePlugin({
      apiVersion: 2,
      name: 'safe-strategy',
      version: '1.0.0',
      type: 'strategy',
      permissions: ['operator:transmit-control', 'radio:control'],
      createStrategyRuntime(ctx) {
        // @ts-expect-error strategy factories receive only the speculative read context
        void ctx.operatorCommands;
        // @ts-expect-error strategy factories cannot capture radio command ports
        void ctx.radioCommands;
        throw new Error('type-only fixture');
      },
      isAutoCallEnabled: () => true,
    });
  });

  it('keeps unload cleanup free of runtime command capabilities', () => {
    definePlugin({
      apiVersion: 2,
      name: 'safe-cleanup',
      version: '1.0.0',
      type: 'utility',
      permissions: ['operator:transmit-control', 'radio:control', 'network'],
      onUnload(ctx) {
        void ctx.store.global.flush();
        ctx.timers.clearAll();
        void ctx.files;
        // @ts-expect-error unload cannot submit operator mutations
        void ctx.operatorCommands;
        // @ts-expect-error unload cannot control the physical radio
        void ctx.radioCommands;
        // @ts-expect-error unload cannot retain network capabilities
        void ctx.network;
      },
      isAutoCallEnabled: () => true,
    });
  });

  it('never exposes raw physical transmission primitives, even with command capabilities', () => {
    definePlugin({
      apiVersion: 2,
      name: 'host-arbitrated-transmit-control',
      version: '1.0.0',
      type: 'utility',
      permissions: ['operator:transmit-control', 'radio:read', 'radio:control', 'radio:power'],
      hooks: {
        async onUserAction(_actionId, _payload, ctx) {
          await ctx.operatorCommands.submit({ type: 'stop-automation' });
          await ctx.radioCommands.submit({ type: 'set-frequency', frequency: 14_074_000 });

          // @ts-expect-error physical PTT ownership is never a plugin capability
          void ctx.setPTT;
          // @ts-expect-error audio playback is owned by PhysicalTxCoordinator
          void ctx.playAudio;
          // @ts-expect-error frame mixing is an internal coordinator detail
          void ctx.audioMixer;
          // @ts-expect-error encoding is submitted through host intents only
          void ctx.encoder;
          // @ts-expect-error global emergency stop is reserved for authenticated host commands
          void ctx.forceStopTransmission;
        },
      },
      isAutoCallEnabled: () => true,
    });
  });

  it('requires an explicit tuner capability for tuner RF actions', () => {
    definePlugin({
      apiVersion: 2,
      name: 'frequency-only',
      version: '1.0.0',
      type: 'utility',
      permissions: ['radio:control'],
      hooks: {
        onUserAction(_actionId, _payload, ctx) {
          void ctx.radioCommands.submit({ type: 'set-frequency', frequency: 7_074_000 });
          // @ts-expect-error tuner RF actions require radio:tuner-control
          void ctx.radioTunerCommands;
        },
      },
    });

    definePlugin({
      apiVersion: 2,
      name: 'tuner-controller',
      version: '1.0.0',
      type: 'utility',
      permissions: ['radio:tuner-control'],
      hooks: {
        onUserAction(_actionId, _payload, ctx) {
          void ctx.radioTunerCommands.submit({ type: 'start-manual-tune' });
          // @ts-expect-error tuner control does not grant frequency control
          void ctx.radioCommands;
        },
      },
    });
  });

});
