const activeTestKeys = new Set<string>();

export function registerTestKey(id: string) {
  activeTestKeys.add(id);
}

export function unregisterTestKey(id: string) {
  activeTestKeys.delete(id);
}

export function isTestKey(id: string) {
  return activeTestKeys.has(id);
}
