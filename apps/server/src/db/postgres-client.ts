import postgres from "postgres";

export function createPostgresClient(url: string, max = 20) {
  const parsed = new URL(url);
  const socketHost = parsed.searchParams.get("host");
  if (!socketHost) return postgres(url, { max });
  const port = parsed.port ? Number(parsed.port) : 5432;
  return postgres({
    path: `${socketHost.replace(/\/$/, "")}/.s.PGSQL.${port}`,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    max,
  });
}
