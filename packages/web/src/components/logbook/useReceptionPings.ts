import { useEffect, useRef, useState } from 'react';
import type { ReceptionTheme } from '../../utils/receptionThemes';
import {
  buildReceptionPingRing,
  type ReceptionPingRing,
  type ReceptionStation,
} from '../../utils/receptionGlobe';

const PING_LIFETIME_MS = 2600;
const PING_MAX_CONCURRENT = 8;
const PING_STAGGER_MAX_MS = 450;
const PING_SPREAD_MS = 4500;

/**
 * One-shot rings for receivers that newly heard this station.
 *
 * Receivers upload in batches, so dozens of reports can land in one second.
 * New receivers are played nearest first, spread over a few seconds, which
 * reads as the signal travelling outwards instead of a single flash. Reports
 * already present when the view opens, and backfilled history, appear without
 * a ring. A receiver that drops out of the window rings again when re-heard.
 *
 * `ready` marks that the server snapshot for `resetKey` has arrived; it is the
 * baseline even when empty, so the first live batch after opening still rings.
 */
export function useReceptionPings(
  stations: ReceptionStation[],
  resetKey: string,
  ready: boolean,
  enabled: boolean,
  theme?: ReceptionTheme,
): ReceptionPingRing[] {
  const [rings, setRings] = useState<ReceptionPingRing[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const resetKeyRef = useRef(resetKey);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const sequenceRef = useRef(0);

  useEffect(() => () => {
    timersRef.current.forEach(timer => clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      seenRef.current = null;
      timersRef.current.forEach(timer => clearTimeout(timer));
      timersRef.current.clear();
      setRings([]);
    }

    const current = new Set(stations.map(station => station.callsign));
    const seen = seenRef.current;
    if (!seen) {
      // The snapshot of this view is shown settled, without rings.
      if (ready) {
        seenRef.current = current;
      }
      return;
    }

    const fresh = stations.filter(station => !seen.has(station.callsign));
    seenRef.current = current;
    if (!enabled) return;

    const live = fresh.filter(station => station.source === 'live');
    if (live.length === 0) return;
    const spacing = Math.min(PING_STAGGER_MAX_MS, PING_SPREAD_MS / live.length);
    // `stations` is ordered nearest first.
    live.forEach((station, index) => {
      const start = setTimeout(() => {
        timersRef.current.delete(start);
        const id = `ping:${station.callsign}:${++sequenceRef.current}`;
        setRings(active => (active.length >= PING_MAX_CONCURRENT ? active : [...active, buildReceptionPingRing(station, id, theme)]));
        const end = setTimeout(() => {
          timersRef.current.delete(end);
          setRings(active => active.filter(ring => ring.id !== id));
        }, PING_LIFETIME_MS);
        timersRef.current.add(end);
      }, Math.round(index * spacing));
      timersRef.current.add(start);
    });
  }, [stations, resetKey, ready, enabled, theme]);

  return rings;
}
