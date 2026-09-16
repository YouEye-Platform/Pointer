export function assertCatalogPostgresTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  const expectedDatabase = process.env.CATALOG_POSTGRES_TEST_DATABASE;
  if (!databaseUrl || !expectedDatabase) {
    throw new Error("Catalog PostgreSQL tests require DATABASE_URL and CATALOG_POSTGRES_TEST_DATABASE");
  }
  const actualDatabase = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (actualDatabase !== expectedDatabase || !/(?:^|[_-])test(?:$|[_-])/i.test(actualDatabase)) {
    throw new Error(`Refusing destructive catalog tests against database ${actualDatabase || "<unknown>"}`);
  }
}
