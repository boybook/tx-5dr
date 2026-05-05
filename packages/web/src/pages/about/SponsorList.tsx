import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, Card, CardBody, CardHeader, Chip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { useSponsors, type Sponsor, type SponsorTier } from '../../hooks/useSponsors';
import { openExternal } from '../../utils/openExternal';

const TIER_ORDER: SponsorTier[] = ['gold', 'silver', 'bronze', 'individual'];

const TIER_COLORS: Record<SponsorTier, 'warning' | 'default' | 'primary' | 'secondary'> = {
  gold: 'warning',
  silver: 'default',
  bronze: 'secondary',
  individual: 'primary',
};

const SPONSOR_URL = 'https://github.com/boybook/tx-5dr#-sponsor';

export const SponsorList: React.FC = () => {
  const { t } = useTranslation('about');
  const { sponsors, loading } = useSponsors();

  const grouped = useMemo(() => {
    const result: Record<SponsorTier, Sponsor[]> = {
      gold: [],
      silver: [],
      bronze: [],
      individual: [],
    };
    for (const s of sponsors) {
      const tier: SponsorTier = TIER_ORDER.includes(s.tier) ? s.tier : 'individual';
      result[tier].push(s);
    }
    return result;
  }, [sponsors]);

  const isEmpty = !loading && sponsors.length === 0;

  return (
    <Card shadow="none">
      <CardHeader className="flex flex-col items-start gap-1 px-6 pt-5 pb-2">
        <h2 className="text-lg font-semibold text-foreground">{t('sponsors.title')}</h2>
        <p className="text-xs text-default-500">{t('sponsors.subtitle')}</p>
      </CardHeader>
      <CardBody className="gap-5 px-6 pb-5">
        {loading && (
          <p className="text-sm text-default-500">{t('loading')}</p>
        )}

        {isEmpty && (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm text-default-500">{t('sponsors.empty')}</p>
            <Button
              color="primary"
              variant="flat"
              size="sm"
              onPress={() => openExternal(SPONSOR_URL)}
            >
              {t('sponsors.becomeSponsor')}
            </Button>
          </div>
        )}

        {!loading && sponsors.length > 0 && TIER_ORDER.map((tier) => {
          const items = grouped[tier];
          if (!items || items.length === 0) return null;
          return (
            <div key={tier} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-default-700 uppercase tracking-wide">
                {t(`sponsors.tier.${tier}`)}
              </h3>
              <ul className="flex flex-col gap-3">
                {items.map((sponsor, idx) => (
                  <li
                    key={`${tier}-${sponsor.name}-${idx}`}
                    className="flex items-start gap-3"
                  >
                    <Avatar
                      src={sponsor.avatar}
                      name={sponsor.name}
                      size="md"
                      className="flex-shrink-0"
                    />
                    <div className="flex flex-col flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {sponsor.url ? (
                          <a
                            href={sponsor.url}
                            onClick={(e) => {
                              e.preventDefault();
                              openExternal(sponsor.url!);
                            }}
                            className="text-foreground font-medium hover:underline cursor-pointer inline-flex items-center gap-1"
                          >
                            {sponsor.name}
                            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="text-xs opacity-60" />
                          </a>
                        ) : (
                          <span className="text-foreground font-medium">{sponsor.name}</span>
                        )}
                        {sponsor.amount && (
                          <Chip size="sm" variant="flat" color={TIER_COLORS[tier]}>
                            {sponsor.amount}
                          </Chip>
                        )}
                        <span className="text-xs text-default-400">
                          {t('sponsors.since', { date: sponsor.since })}
                        </span>
                      </div>
                      {sponsor.message && (
                        <p className="text-sm text-default-500 mt-1 italic">
                          “{sponsor.message}”
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
};
