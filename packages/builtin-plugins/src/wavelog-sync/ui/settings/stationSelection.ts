export interface StationOption {
  station_id: string;
}

export function resolveSelectedStationId(
  stations: StationOption[],
  preferredStationId?: string | null,
): string {
  const trimmedPreferred = preferredStationId?.trim() ?? '';

  if (trimmedPreferred && stations.some(station => station.station_id === trimmedPreferred)) {
    return trimmedPreferred;
  }

  return stations[0]?.station_id ?? '';
}
