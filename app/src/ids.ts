// Sign id scheme. Plain ids come straight from the map data ("123", "badge-3");
// prefixed ids carry extra meaning:
//   "biz-<n>"       business signs from the map data
//   "user:<ts>"     signs the user placed on the map themselves
//   "manual:<code>" hand-entered codes with no sign in the map data

/** Id for a hand-entered code with no sign in the map data. */
export function manualId(code: string): string {
  return "manual:" + code.toLowerCase();
}

/** Fresh id for a sign the user places on the map themselves. */
export function newMySignId(): string {
  return `user:${Date.now()}`;
}

/** Ids of hand-entered codes with no sign in the map data. */
export function isManualId(id: string): boolean {
  return id.startsWith("manual:");
}

/** Ids of signs the user placed on the map themselves. */
export function isMySignId(id: string): boolean {
  return id.startsWith("user:");
}

/** Ids of business signs. */
export function isBizId(id: string): boolean {
  return id.startsWith("biz-");
}
