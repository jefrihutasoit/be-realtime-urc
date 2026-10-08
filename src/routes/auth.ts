import { Router } from "express";
import { currentUser } from "../middleware/auth.js";
import { authStore } from "../services/auth-store.js";

export const authRouter = Router();

/** `{ username, password }` → `{ token, user }`. */
authRouter.post("/login", async (req, res) => {
  res.json(await authStore.login(req.body));
});

authRouter.post("/logout", async (_req, res) => {
  await authStore.logout(res.locals.token as string);
  res.json({ ok: true });
});

authRouter.get("/me", (_req, res) => {
  res.json(currentUser(res.locals));
});

/** `{ currentPassword, newPassword }`. */
authRouter.post("/password", async (req, res) => {
  await authStore.changeOwnPassword(currentUser(res.locals).id, req.body);
  res.json({ ok: true });
});
