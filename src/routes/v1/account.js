import { Router } from "express";
import { h } from "../../util.js";

// GET /v1/account  -> { tenant, prefixes }
export default function accountRoutes({ pool }) {
  const r = Router();

  r.get(
    "/",
    h(async (req, res) => {
      const [rows] = await pool.query(
        "SELECT prefix FROM v_export_account WHERE tenant = ? LIMIT 1",
        [req.tenant],
      );
      const prefixes = String(rows[0]?.prefix ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      res.json({ tenant: req.tenant, prefixes });
    }),
  );

  return r;
}