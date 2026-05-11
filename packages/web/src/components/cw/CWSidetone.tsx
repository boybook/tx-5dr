import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { encodeMorseSchedule } from '../../utils/morseEncoder';

const RAMP_MS = 3; // envelope ramp duration to eliminate clicks

export interface CWSidetoneHandle {
  play(text: string): void;
  stop(): void;
}

interface CWSidetoneProps {
  wpm: number;
  frequency: number;
  enabled: boolean;
  volume?: number;
}

/**
 * Client-side CW sidetone generator.
 *
 * Encodes plain text into a Morse timing schedule and plays it
 * through a Web Audio API sine oscillator — zero server dependency.
 * Supports configurable frequency and WPM-matched speed.
 */
export const CWSidetone = forwardRef<CWSidetoneHandle, CWSidetoneProps>(
  function CWSidetone({ wpm, frequency, enabled, volume = 0.3 }, ref) {
    const audioCtxRef = useRef<AudioContext | null>(null);
    const stopTokenRef = useRef<symbol | null>(null);
    const activeNodesRef = useRef<{ osc: OscillatorNode; gain: GainNode } | null>(null);

    const getCtx = useCallback((): AudioContext => {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      return ctx;
    }, []);

    const stop = useCallback(() => {
      stopTokenRef.current = null;
      const nodes = activeNodesRef.current;
      if (nodes) {
        activeNodesRef.current = null;
        try { nodes.osc.stop(); } catch { /* already stopped */ }
        try { nodes.osc.disconnect(); } catch { /* ok */ }
        try { nodes.gain.disconnect(); } catch { /* ok */ }
      }
    }, []);

    const play = useCallback((text: string) => {
      if (!enabled || !text.trim()) return;

      const schedule = encodeMorseSchedule(text.trim(), wpm);
      if (schedule.length === 0) return;

      // Stop any previous playback (token + active oscillator)
      stop();

      const token = Symbol('sidetone');
      stopTokenRef.current = token;

      try {
        const ctx = getCtx();
        const now = ctx.currentTime;

        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = Math.max(200, Math.min(2000, Math.round(frequency)));
        gainNode.gain.value = 0;

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        // Track active nodes for immediate stop
        activeNodesRef.current = { osc: oscillator, gain: gainNode };

        let t = now + 0.005; // tiny offset to avoid initial click

        for (const event of schedule) {
          // Check stop token at each event boundary
          if (stopTokenRef.current !== token) break;

          const durationSec = event.durationMs / 1000;
          if (event.tone && durationSec > 0) {
            // Key-down: ramp up, hold, ramp down
            const ramp = Math.min(RAMP_MS / 1000, durationSec / 3);
            gainNode.gain.setValueAtTime(0, t);
            gainNode.gain.linearRampToValueAtTime(volume, t + ramp);
            const releaseStart = t + durationSec - ramp;
            if (releaseStart > t + ramp) {
              gainNode.gain.setValueAtTime(volume, releaseStart);
            }
            gainNode.gain.linearRampToValueAtTime(0, t + durationSec);
          }
          // For silence events, gain stays at 0 — just advance time
          t += durationSec;
        }

        oscillator.start(now);
        oscillator.stop(t + 0.05);

        // Clean up when playback finishes
        const timeoutMs = (t - now) * 1000 + 100;
        const timer = setTimeout(() => {
          if (stopTokenRef.current === token) {
            stopTokenRef.current = null;
          }
          if (activeNodesRef.current?.osc === oscillator) {
            activeNodesRef.current = null;
          }
          try {
            oscillator.disconnect();
            gainNode.disconnect();
          } catch { /* already disconnected */ }
        }, timeoutMs);

        // If stopped early, clean up immediately
        const checkStop = () => {
          if (stopTokenRef.current !== token) {
            clearTimeout(timer);
            try { oscillator.stop(); } catch { /* ok */ }
            try { oscillator.disconnect(); } catch { /* ok */ }
            try { gainNode.disconnect(); } catch { /* ok */ }
            if (activeNodesRef.current?.osc === oscillator) {
              activeNodesRef.current = null;
            }
          }
        };
        // Schedule a check right after the last event
        setTimeout(checkStop, (t - now) * 1000 + 10);
      } catch {
        // Audio unavailable — silent
      }
    }, [enabled, wpm, frequency, volume, getCtx]);

    useImperativeHandle(ref, () => ({ play, stop }), [play, stop]);

    // Clean up audio context on unmount
    useEffect(() => {
      return () => {
        stop();
        if (audioCtxRef.current) {
          audioCtxRef.current.close().catch(() => {});
          audioCtxRef.current = null;
        }
      };
    }, [stop]);

    // Invisible component
    return null;
  },
);
