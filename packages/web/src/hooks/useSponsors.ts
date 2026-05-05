import { useEffect, useState } from 'react';
import { createLogger } from '../utils/logger';

const logger = createLogger('useSponsors');

export type SponsorTier = 'gold' | 'silver' | 'bronze' | 'individual';

export interface Sponsor {
  name: string;
  tier: SponsorTier;
  amount?: string;
  since: string;
  url?: string;
  avatar?: string;
  message?: string;
}

interface UseSponsorsResult {
  sponsors: Sponsor[];
  loading: boolean;
  error: boolean;
}

/**
 * Fetch sponsors.json from the public directory at runtime.
 * On error returns an empty list so the UI can show the "be the first" empty state.
 */
export function useSponsors(): UseSponsorsResult {
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('./sponsors.json', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data: unknown) => {
        if (cancelled) return;
        if (Array.isArray(data)) {
          setSponsors(data as Sponsor[]);
        } else {
          setSponsors([]);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        logger.warn('sponsors fetch failed', err);
        setSponsors([]);
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { sponsors, loading, error };
}
