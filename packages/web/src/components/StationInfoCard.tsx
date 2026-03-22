import React from 'react';
import { Card, CardBody } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRadio, faLocationDot } from '@fortawesome/free-solid-svg-icons';
import type { StationInfo } from '@tx5dr/contracts';

interface StationInfoCardProps {
  stationInfo: StationInfo;
}

export const StationInfoCard: React.FC<StationInfoCardProps> = ({ stationInfo }) => {
  const { name, callsign, description, qth } = stationInfo;

  const hasContent = callsign || name || description || qth?.grid || qth?.location;
  if (!hasContent) return null;

  const descPreview = description
    ? description.length > 120
      ? description.slice(0, 120) + '…'
      : description
    : null;

  return (
    <Card className="w-full max-w-md mx-4 mb-3 border border-default-200 bg-content1">
      <CardBody className="gap-2 px-6 py-4">
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faRadio} className="text-primary text-sm flex-shrink-0" />
          <div className="min-w-0">
            {callsign && (
              <span className="font-bold text-foreground text-base mr-2">{callsign}</span>
            )}
            {name && (
              <span className="text-default-600 text-sm">{name}</span>
            )}
          </div>
        </div>

        {(qth?.location || qth?.grid) && (
          <div className="flex items-center gap-2 text-sm text-default-500">
            <FontAwesomeIcon icon={faLocationDot} className="text-xs flex-shrink-0" />
            <span>
              {qth.location}
              {qth.location && qth.grid && ' · '}
              {qth.grid && (
                <a
                  href={`https://www.qrz.com/gridmapper?grid=${qth.grid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {qth.grid}
                </a>
              )}
            </span>
          </div>
        )}

        {descPreview && (
          <p className="text-xs text-default-400 leading-relaxed mt-1 whitespace-pre-line">
            {descPreview}
          </p>
        )}
      </CardBody>
    </Card>
  );
};
