import React, { useEffect, useState } from 'react';
import { Popover, PopoverTrigger, PopoverContent, Button, Divider, Skeleton } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faRadio, faLocationDot, faPencil, faComputer, faTowerBroadcast, faSliders } from '@fortawesome/free-solid-svg-icons';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import { api } from '@tx5dr/core';
import { useStationInfo } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { getGridBounds, UserRole, type StationInfo } from '@tx5dr/contracts';
import { hasDesktopCapability } from '../../utils/desktopBridge';
import { openStationManager, useCurrentDesktopStation } from '../../utils/desktopStations';
import { displayHost } from '../stations/stationText';

// 使用 Carto @2x 瓦片（512×512px 输出），以 256px CSS 尺寸渲染：
// - 在 2× Retina 屏上：256 CSS px = 512 物理像素 = 1 张 @2x 瓦片，完全清晰
// - 在 1× 屏上：256 CSS px 显示 512px 瓦片，细节更丰富
const CSS_TILE = 256;        // CSS 渲染尺寸（也用于坐标计算）
const ZOOM = 5;
const CONTAINER_W = 264;     // w-72(288px) 减去 p-3 两侧各 12px
const CONTAINER_H = 120;

/** 计算 3×3 瓦片网格，让指定点落在容器中心。返回坐标均为 CSS 像素 */
function getTileGrid(lat: number, lon: number) {
  const n = Math.pow(2, ZOOM);
  const cx = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const cy = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const fracX = (lon + 180) / 360 * n - cx;
  const fracY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - cy;
  // 目标点在 3×3 网格中的 CSS 坐标
  const pointX = CSS_TILE + fracX * CSS_TILE;
  const pointY = CSS_TILE + fracY * CSS_TILE;
  const gridLeft = CONTAINER_W / 2 - pointX;
  const gridTop = CONTAINER_H / 2 - pointY;

  const tiles: { url: string; left: number; top: number }[] = [];
  for (let row = -1; row <= 1; row++) {
    for (let col = -1; col <= 1; col++) {
      tiles.push({
        url: `https://a.basemaps.cartocdn.com/rastertiles/voyager/${ZOOM}/${cx + col}/${cy + row}@2x.png`,
        left: (col + 1) * CSS_TILE,
        top: (row + 1) * CSS_TILE,
      });
    }
  }
  return { tiles, gridLeft, gridTop, cx, cy };
}

/** 将经纬度转换为 3×3 瓦片网格中的 CSS 像素坐标（相对于网格左上角） */
function latLonToGridPixel(lat: number, lon: number, cx: number, cy: number) {
  const n = Math.pow(2, ZOOM);
  const tx = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const ty = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return {
    x: (1 + (tx - cx)) * CSS_TILE,
    y: (1 + (ty - cy)) * CSS_TILE,
  };
}

function hasStationProfile(stationInfo: StationInfo | null | undefined): boolean {
  return Boolean(stationInfo?.callsign || stationInfo?.name || stationInfo?.qth?.grid || stationInfo?.description);
}

/**
 * Whether the top-left station tag is shown. Inside the desktop shell it always
 * identifies the station of this window; in a browser it appears once the
 * station has a profile.
 */
export function useStationTagVisible(): boolean {
  const stationInfo = useStationInfo();
  return hasDesktopCapability('stations') || hasStationProfile(stationInfo);
}

/** Host version of this station, loaded when the popover first opens. */
function useStationVersion(enabled: boolean): { version: string | null; loading: boolean } {
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || version !== null) return;
    let cancelled = false;
    setLoading(true);
    api.getStationIdentity()
      .then(identity => { if (!cancelled) setVersion(identity.hostVersion); })
      .catch(() => { /* Older stations have no identity endpoint; the row is omitted. */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, version]);
  return { version, loading };
}

const InfoRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-3 text-tiny">
    <span className="flex-shrink-0 text-default-500">{label}</span>
    <span className="min-w-0 truncate text-right text-foreground">{children}</span>
  </div>
);

export const StationInfoPopover: React.FC = () => {
  const { t } = useTranslation('stations');
  const stationInfo = useStationInfo();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [isOpen, setIsOpen] = useState(false);
  const desktopStation = useCurrentDesktopStation();
  const canOpenManager = hasDesktopCapability('stations');
  const tagVisible = useStationTagVisible();
  const { version, loading: versionLoading } = useStationVersion(isOpen);

  const handleEdit = () => {
    setIsOpen(false);
    window.dispatchEvent(new CustomEvent('openSettingsModal', { detail: { tab: 'station_info' } }));
  };

  const handleManage = () => {
    setIsOpen(false);
    void openStationManager();
  };

  if (!tagVisible) return null;

  const { callsign, name, description, qth } = stationInfo ?? {};
  const isRemote = desktopStation?.kind === 'remote';
  const kindIcon: IconDefinition = !desktopStation ? faRadio : isRemote ? faTowerBroadcast : faComputer;
  const kindLabel = !desktopStation ? t('tag.browser') : isRemote ? t('tag.remote') : t('tag.embedded');
  const fallbackTitle = desktopStation
    ? (isRemote ? desktopStation.label ?? t('tag.remote') : t('tag.embedded'))
    : window.location.host;
  const tagTitle = callsign || name || fallbackTitle;
  const tagDetail = qth?.grid ?? null;
  const address = isRemote && desktopStation?.url ? displayHost(desktopStation.url) : !desktopStation ? window.location.host : null;

  const hasPreciseCoords = qth?.latitude != null && qth?.longitude != null;
  const hasGrid = !hasPreciseCoords && qth?.grid && qth.grid.length >= 4;

  const mapData = (() => {
    if (hasPreciseCoords) {
      const grid = getTileGrid(qth!.latitude!, qth!.longitude!);
      return { type: 'point' as const, grid };
    }
    if (hasGrid) {
      const bounds = getGridBounds(qth!.grid!);
      if (!bounds) return null;
      const grid = getTileGrid(bounds.centerLat, bounds.centerLon);
      // 6字符子网格在当前缩放级别下极小，改为圆点标注中心
      if (qth!.grid!.length >= 6) {
        return { type: 'point' as const, grid };
      }
      const nw = latLonToGridPixel(bounds.latMax, bounds.lonMin, grid.cx, grid.cy);
      const se = latLonToGridPixel(bounds.latMin, bounds.lonMax, grid.cx, grid.cy);
      return {
        type: 'grid' as const,
        grid,
        rect: {
          left: grid.gridLeft + nw.x,
          top: grid.gridTop + nw.y,
          width: se.x - nw.x,
          height: se.y - nw.y,
        },
        href: `https://www.openstreetmap.org/#map=8/${bounds.centerLat}/${bounds.centerLon}`,
      };
    }
    return null;
  })();

  const mapHref = hasPreciseCoords
    ? `https://www.openstreetmap.org/?mlat=${qth!.latitude}&mlon=${qth!.longitude}#map=10/${qth!.latitude}/${qth!.longitude}`
    : mapData?.type === 'grid' ? mapData.href : undefined;

  return (
    <Popover placement="bottom-start" isOpen={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger>
        <div
          role="button"
          tabIndex={0}
          aria-label={`${kindLabel}: ${tagTitle}`}
          className="flex max-w-[16rem] items-center gap-1.5 rounded-md bg-default-100 px-2 py-1 text-xs
                     cursor-pointer select-none transition-[background-color,transform] duration-150
                     hover:bg-default-200 active:scale-[0.97] outline-none
                     data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-focus focus-visible:ring-2 focus-visible:ring-focus"
          onKeyDown={e => e.key === 'Enter' && setIsOpen(o => !o)}
        >
          <FontAwesomeIcon icon={kindIcon} className={`text-xs ${isRemote ? 'text-secondary' : 'text-primary'}`} />
          <span className={`truncate text-foreground ${callsign ? 'font-bold' : 'font-medium'}`}>{tagTitle}</span>
          {tagDetail && (
            <span className="flex-shrink-0 text-default-400 font-mono">{tagDetail}</span>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent>
        <div className="p-3 w-72 max-h-[28rem] overflow-y-auto">
          <div className="flex items-center gap-2 mb-2">
            <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-medium ${isRemote ? 'bg-secondary/10 text-secondary' : 'bg-primary/10 text-primary'}`}>
              <FontAwesomeIcon icon={kindIcon} className="text-sm" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <span className={`text-foreground text-sm mr-1 ${callsign ? 'font-bold' : 'font-semibold'}`}>{callsign || name || fallbackTitle}</span>
                {callsign && name && (
                  <span className="text-default-600 text-xs">{name}</span>
                )}
              </div>
              <p className="truncate text-tiny text-default-500">{kindLabel}</p>
            </div>
            {isAdmin && (
              <Button
                isIconOnly
                size="sm"
                variant="light"
                onPress={handleEdit}
                className="text-default-400 hover:text-primary flex-shrink-0"
              >
                <FontAwesomeIcon icon={faPencil} className="text-xs" />
              </Button>
            )}
          </div>

          {(qth?.location || qth?.grid) && (
            <div className="flex items-center gap-1.5 text-xs text-default-500 mb-2">
              <FontAwesomeIcon icon={faLocationDot} className="text-xs flex-shrink-0" />
              <span>
                {qth?.location}
                {qth?.location && qth?.grid && ' · '}
                {qth?.grid && (
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

          {mapData && (
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              className="block mb-2 overflow-hidden cursor-pointer rounded-lg"
              style={{
                position: 'relative',
                width: '100%',
                height: CONTAINER_H,
              }}
            >
              {/* 3×3 瓦片背景 */}
              <div style={{
                position: 'absolute',
                left: mapData.grid.gridLeft,
                top: mapData.grid.gridTop,
                width: CSS_TILE * 3,
                height: CSS_TILE * 3,
              }}>
                {mapData.grid.tiles.map(tile => (
                  <img
                    key={tile.url}
                    src={tile.url}
                    alt=""
                    style={{
                      position: 'absolute',
                      left: tile.left,
                      top: tile.top,
                      width: CSS_TILE,
                      height: CSS_TILE,
                      pointerEvents: 'none',
                      userSelect: 'none',
                    }}
                    loading="lazy"
                  />
                ))}
              </div>

              {/* 精确坐标：红点标记 */}
              {mapData.type === 'point' && (
                <div style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 10,
                  height: 10,
                  backgroundColor: '#e53935',
                  borderRadius: '50%',
                  border: '2px solid white',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                }} />
              )}

              {/* 网格模式：半透明矩形区域 */}
              {mapData.type === 'grid' && (
                <div style={{
                  position: 'absolute',
                  left: mapData.rect.left,
                  top: mapData.rect.top,
                  width: mapData.rect.width,
                  height: mapData.rect.height,
                  backgroundColor: 'rgba(229, 57, 53, 0.25)',
                  border: '2px solid rgba(229, 57, 53, 0.8)',
                  pointerEvents: 'none',
                }} />
              )}
            </a>
          )}

          {description && (
            <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-default-600 leading-relaxed
                            [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1 [&>h1]:text-sm [&>h2]:text-sm [&>h3]:text-xs">
              <ReactMarkdown>{description}</ReactMarkdown>
            </div>
          )}

          <Divider className="my-2.5" />
          <div className="flex flex-col gap-1.5">
            <InfoRow label={t('tag.connection')}>
              {/* The header already names the station when it has no callsign or name. */}
              {isRemote && desktopStation?.label && (callsign || name) ? `${kindLabel} · ${desktopStation.label}` : kindLabel}
            </InfoRow>
            {address && (
              <InfoRow label={t('tag.address')}><span className="font-mono">{address}</span></InfoRow>
            )}
            {(version || versionLoading) && (
              <InfoRow label={t('tag.version')}>
                {version ?? <Skeleton className="ml-auto h-3 w-14 rounded-small" />}
              </InfoRow>
            )}
          </div>

          {canOpenManager && (
            <Button
              size="sm"
              variant="flat"
              fullWidth
              className="mt-3"
              startContent={<FontAwesomeIcon icon={faSliders} className="text-xs" />}
              onPress={handleManage}
            >
              {t('tag.manage')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
