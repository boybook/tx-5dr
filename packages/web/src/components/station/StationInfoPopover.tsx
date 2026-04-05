import React, { useState } from 'react';
import { Popover, PopoverTrigger, PopoverContent, Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRadio, faLocationDot, faPencil } from '@fortawesome/free-solid-svg-icons';
import ReactMarkdown from 'react-markdown';
import { useStationInfo } from '../../store/radioStore';
import { useHasMinRole } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';

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

/** 解析 Maidenhead 网格（4 或 6 字符），返回边界和中心坐标 */
function getGridBounds(grid: string) {
  const g = grid.toUpperCase();
  if (g.length < 4) return null;
  const lonField = g.charCodeAt(0) - 65;
  const latField = g.charCodeAt(1) - 65;
  const lonSquare = parseInt(g[2]);
  const latSquare = parseInt(g[3]);
  let lonMin = lonField * 20 - 180 + lonSquare * 2;
  let lonMax = lonMin + 2;
  let latMin = latField * 10 - 90 + latSquare;
  let latMax = latMin + 1;

  if (g.length >= 6) {
    const lonSub = g.charCodeAt(4) - 65; // A=0 .. X=23
    const latSub = g.charCodeAt(5) - 65;
    lonMin = lonMin + lonSub * (2 / 24);
    lonMax = lonMin + (2 / 24);
    latMin = latMin + latSub * (1 / 24);
    latMax = latMin + (1 / 24);
  }

  return {
    lonMin, lonMax, latMin, latMax,
    centerLon: (lonMin + lonMax) / 2,
    centerLat: (latMin + latMax) / 2,
  };
}

export const StationInfoPopover: React.FC = () => {
  const stationInfo = useStationInfo();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [isOpen, setIsOpen] = useState(false);

  const handleEdit = () => {
    setIsOpen(false);
    window.dispatchEvent(new CustomEvent('openSettingsModal', { detail: { tab: 'station_info' } }));
  };

  const hasContent =
    stationInfo?.callsign || stationInfo?.name || stationInfo?.qth?.grid || stationInfo?.description;
  if (!hasContent) return null;

  const { callsign, name, description, qth } = stationInfo!;

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
          className="flex items-center gap-1.5 bg-default-100 hover:bg-default-200 rounded-md px-2 py-1
                     cursor-pointer transition-colors text-xs select-none"
          onKeyDown={e => e.key === 'Enter' && setIsOpen(o => !o)}
        >
          <FontAwesomeIcon icon={faRadio} className="text-primary text-xs" />
          {callsign && <span className="font-bold text-foreground">{callsign}</span>}
          {qth?.grid && (
            <span className="text-default-400 font-mono">{qth.grid}</span>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent>
        <div className="p-3 w-72 max-h-96 overflow-y-auto">
          <div className="flex items-center gap-2 mb-2">
            <FontAwesomeIcon icon={faRadio} className="text-primary text-sm flex-shrink-0" />
            <div className="min-w-0 flex-1">
              {callsign && (
                <span className="font-bold text-foreground text-sm mr-1">{callsign}</span>
              )}
              {name && (
                <span className="text-default-600 text-xs">{name}</span>
              )}
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
        </div>
      </PopoverContent>
    </Popover>
  );
};
