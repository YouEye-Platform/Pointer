import { api } from "./api";
import { useAuth } from "./store";

import { createCatalogSync } from "./catalog-sync-state";

const sync = createCatalogSync(
  async () => {
    const result = await api.post<{ catalogWarning?: string }>("/api/connections/sync", { reference: false });
    if (result.catalogWarning) throw new Error(result.catalogWarning);
  },
);
export const syncConnectedCatalog = (force = false) =>
  sync(useAuth.getState().user?.id ?? "", force);
