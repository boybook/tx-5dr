export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Where a ray first meets the globe sphere, in latitude and longitude
 * (three-globe axes: prime meridian on +Z, 90E on +X, north pole on +Y).
 *
 * Analytic, so hover lookups stay cheap; globe.gl's own toGlobeCoords
 * raycasts every object in the scene.
 */
export function intersectGlobe(origin: Vec3Like, direction: Vec3Like, radius: number): { lat: number; lng: number } | null {
  const dirLength = Math.hypot(direction.x, direction.y, direction.z);
  if (!(dirLength > 0) || !(radius > 0)) return null;
  const dx = direction.x / dirLength;
  const dy = direction.y / dirLength;
  const dz = direction.z / dirLength;
  const b = origin.x * dx + origin.y * dy + origin.z * dz;
  const c = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const t = -b - Math.sqrt(discriminant);
  if (t < 0) return null;
  const x = origin.x + dx * t;
  const y = origin.y + dy * t;
  const z = origin.z + dz * t;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, y / radius))) * 180 / Math.PI,
    lng: Math.atan2(x, z) * 180 / Math.PI,
  };
}
