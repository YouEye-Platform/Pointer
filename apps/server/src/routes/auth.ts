import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";
import { signJwt, hashPassword, verifyPassword, authMiddleware, type AuthUser } from "../middleware/auth";
import { config } from "../config";
import { platformError } from "../services/platform-errors";

const app = new Hono<{ Variables: { user: AuthUser } }>();

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

app.post("/register", async (c) => {
  if (config.mode === "managed") {
    return platformError(
      c,
      404,
      "local_auth_disabled",
      "Local registration is unavailable in managed mode"
    );
  }
  const body = registerSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const { email, name, password } = body.data;

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing.length > 0) return c.json({ error: "Email already registered" }, 409);

  const allUsers = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  const role = allUsers.length === 0 ? "admin" : "user";

  const id = nanoid();
  const passwordHash = await hashPassword(password);

  await db.insert(schema.users).values({
    id,
    kind: "local",
    email,
    name,
    passwordHash,
    role,
    state: "active",
  });

  await db.insert(schema.modelGroups).values({
    id: `grp_${nanoid(12)}`,
    userId: id,
    name: "Favorites",
    isDefault: true,
    position: 0,
  });

  const token = await signJwt({ id, email, name, role });
  return c.json({ token, user: { id, email, name, role } }, 201);
});

app.post("/login", async (c) => {
  if (config.mode === "managed") {
    return platformError(
      c,
      404,
      "local_auth_disabled",
      "Local login is unavailable in managed mode"
    );
  }
  const body = loginSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const { email, password } = body.data;

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (
    !user
    || user.kind !== "local"
    || user.state !== "active"
    || !user.email
    || !user.passwordHash
  ) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = await signJwt({ id: user.id, email: user.email, name: user.name, role: user.role });
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get("/me", authMiddleware, async (c) => {
  const user = c.get("user");
  const [full] = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  if (!full) return c.json({ error: "User not found" }, 404);
  return c.json({
    id: full.id,
    email: full.email,
    name: full.name,
    role: full.role,
    avatarUrl: full.avatarUrl,
    createdAt: full.createdAt,
  });
});

export default app;
