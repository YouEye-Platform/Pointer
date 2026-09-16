import { Hono } from "hono";
import { authMiddleware, type AuthUser } from "../middleware/auth";
// Use the durable account-scoped flow; never discard refresh credentials.
const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);
app.all("*", (c) => c.json({
  error: "Use the provider account device authorization flow",
  code: "oauth_login_upgrade_required",
}, 410));
export default app;
