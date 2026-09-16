import { describe, expect, test } from "bun:test";
import { projectCatalogAvailability } from "./catalog-availability";

const routes = (...providerIds: string[]) => providerIds.map((providerId, index) => ({
  id: `route-${index}`,
  providerId,
  providerModelKey: `model-${index}`,
}));

describe("catalog availability", () => {
  test("requires an active route and the current user's own provider connection", () => {
    expect(projectCatalogAvailability(routes("provider-a"), new Set(["model-0"]))).toMatchObject({
      available: true,
      providerCount: 1,
      availableProviderCount: 1,
    });
    expect(projectCatalogAvailability(routes("provider-a"), new Set())).toMatchObject({
      available: false,
      availableProviderCount: 0,
    });
    expect(projectCatalogAvailability([], new Set(["model-0"]))).toMatchObject({
      available: false,
      providerCount: 0,
      availableProviderCount: 0,
    });
  });

  test("is independent of instances, groups, shared credentials, and global provider state", () => {
    const connectionOnly = projectCatalogAvailability(routes("provider-a"), new Set(["model-0"]));
    expect(connectionOnly.available).toBe(true);

    const unrelatedExposure = projectCatalogAvailability(routes("provider-b"), new Set());
    expect(unrelatedExposure.available).toBe(false);

    const sharedOnly = projectCatalogAvailability(routes("provider-c"), new Set());
    expect(sharedOnly.available).toBe(false);

    const providerInErrorWithOwnConnection = projectCatalogAvailability(
      [{ id: "route", providerId: "provider-d", providerModelKey: "model-d", globalStatus: "error" }],
      new Set(["model-d"]),
    );
    expect(providerInErrorWithOwnConnection.routes[0]).toMatchObject({
      providerId: "provider-d",
      globalStatus: "error",
      available: true,
    });
  });

  test("counts distinct providers while retaining exact route choices", () => {
    const projection = projectCatalogAvailability(
      routes("provider-a", "provider-a", "provider-b", "provider-c"),
      new Set(["model-0", "model-1", "model-2"]),
    );
    expect(projection.routes).toHaveLength(4);
    expect(projection.providerCount).toBe(3);
    expect(projection.availableProviderCount).toBe(2);
    expect(projection.available).toBe(true);
  });

  test("does not double count duplicate own/shared evidence", () => {
    const projection = projectCatalogAvailability(routes("provider-a", "provider-a"), new Set(["model-0", "model-1"]));
    expect(projection.availableProviderCount).toBe(1);
  });

  test("projects list and detail deterministically from identical inputs", () => {
    const input = routes("provider-b", "provider-a", "provider-b");
    const connected = new Set(["model-0", "model-2"]);
    expect(projectCatalogAvailability(input, connected)).toEqual(projectCatalogAvailability(input, connected));
  });

  test("treats internal catalog loads without user context as unavailable", () => {
    const projection = projectCatalogAvailability(routes("provider-a"), new Set());
    expect(projection.routes[0]?.available).toBe(false);
    expect(projection.available).toBe(false);
  });
});
