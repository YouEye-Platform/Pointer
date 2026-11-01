/** Share discovery across simultaneous catalog views without caching a failure.
 * Only non-secret provider inventory is refreshed; reference/benchmark downloads
 * are an explicit, separate action. Authentication remains on the API boundary.
 */
export function createCatalogSync(
  refresh: () => Promise<unknown>,
  now: () => number = Date.now,
) {
  const owners = new Map<string, { pending?: Promise<void>; freshUntil: number }>();
  return (owner: string, force = false) => {
    if (!owner) return Promise.reject(new Error("A signed-in owner is required"));
    const state = owners.get(owner) ?? { freshUntil: 0 };
    owners.set(owner, state);
    if (state.pending) return state.pending;
    if (!force && now() < state.freshUntil) return Promise.resolve();
    state.pending = refresh().then(() => { state.freshUntil = now() + 15_000; })
      .finally(() => { state.pending = undefined; });
    return state.pending;
  };
}

