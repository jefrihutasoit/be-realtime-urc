import { Router } from "express";
import { currentUser } from "../middleware/auth.js";
import { authStore } from "../services/auth-store.js";
import { PERMISSIONS } from "../types/auth.js";

export const usersRouter = Router();

/** Permissions per role (`RolePermissions`) and the permissions that can be given. */
usersRouter.get("/roles", async (_req, res) => {
  res.json({ roles: await authStore.rolePermissions(), permissions: PERMISSIONS });
});

usersRouter.put("/roles", async (req, res) => {
  res.json(await authStore.updateRolePermissions(req.body));
});

usersRouter.get("/", async (_req, res) => {
  res.json(await authStore.list(currentUser(res.locals)));
});

usersRouter.post("/", async (req, res) => {
  res.status(201).json(await authStore.create(req.body, currentUser(res.locals)));
});

usersRouter.patch("/:id", async (req, res) => {
  res.json(await authStore.update(req.params.id, req.body, currentUser(res.locals)));
});

usersRouter.delete("/:id", async (req, res) => {
  await authStore.remove(req.params.id, currentUser(res.locals));
  res.json({ ok: true });
});
