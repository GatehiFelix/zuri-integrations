import { Router } from "express";
import accountRoutes from "./account.js";
import campaignRoutes from "./campaigns.js";
import contactRoutes from "./contacts.js";
import pendingRoutes from "./pending.js";
import membersRoutes from "./member.js";
import recordingsRoutes from "./recordings.js";
import { pool } from "../../db.js"; 

// Everything under /v1. To expose a new resource: add a routes file here and mount it below.
export default function v1Routes(deps) {
  const r = Router();
  r.use("/account", accountRoutes(deps));
  r.use("/campaigns/:id/contacts", contactRoutes(deps)); // before /campaigns so it matches first
  r.use("/campaigns", campaignRoutes(deps));
  r.use("/queue/members", membersRoutes(deps));
  r.use("/contacts/pending", pendingRoutes({ pool }));
  r.use("/recordings", recordingsRoutes({ pool }));
  return r;
}