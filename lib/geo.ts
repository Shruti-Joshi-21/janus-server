// Small geography helpers shared by the Delhivery mock and the custom capabilities.

const EARTH_RADIUS_KM = 6371;
export const ROAD_FACTOR = 1.3; // roads are ~30% longer than the straight line in Pune

// Straight-line ("as the crow flies") distance in km.
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Rough India bounding box (mainland + islands), used to reject coordinates outside India.
export function insideIndia(lat: number, lng: number): boolean {
  return lat >= 6 && lat <= 37.6 && lng >= 68 && lng <= 97.5;
}
