import { Router } from "express";
import { HttpError } from "../lib/http-error.js";
import { currentUser } from "../middleware/auth.js";
import { license } from "../services/license.js";

// License: the status (with the hardware ID) is open to everyone; installing needs the Engineering account.
// Both work while the system is not licensed (see middleware/auth.ts).

export const licenseRouter = Router();

licenseRouter.get("/", (_req, res) => {
  res.json(license.status());
});

/** Body: { content: "<text of the .lic file>" }. */
licenseRouter.post("/", (req, res) => {
  const user = currentUser(res.locals);
  if (user?.role !== "ENGINEERING") throw new HttpError(403, "You do not have permission to install a license");
  res.json(license.install(req.body?.content, user.username));
});
