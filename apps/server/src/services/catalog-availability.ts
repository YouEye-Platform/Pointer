export type CatalogRouteIdentity = {
  providerId: string;
  providerModelKey: string;
};

export type AvailableCatalogRoute<T extends CatalogRouteIdentity> = T & {
  available: boolean;
};

export function projectCatalogAvailability<T extends CatalogRouteIdentity>(
  routes: readonly T[],
  availableProviderModelKeys: ReadonlySet<string>,
): {
  routes: AvailableCatalogRoute<T>[];
  providerCount: number;
  availableProviderCount: number;
  available: boolean;
} {
  const projected = routes.map((route) => ({
    ...route,
    available: availableProviderModelKeys.has(route.providerModelKey),
  }));
  const providerCount = new Set(projected.map((route) => route.providerId)).size;
  const availableProviderCount = new Set(
    projected.filter((route) => route.available).map((route) => route.providerId),
  ).size;
  return {
    routes: projected,
    providerCount,
    availableProviderCount,
    available: availableProviderCount > 0,
  };
}
