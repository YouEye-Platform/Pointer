import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { createPostgresClient } from "./postgres-client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const client = createPostgresClient(connectionString);

export const db = drizzle(client, { schema });
export type Database = typeof db;
export { schema };
