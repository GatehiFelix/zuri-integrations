import { Router } from "express";
import { h, str, ISO, MAX_LIMIT } from "../../api/util.js";

// GET /v1/campaigns[?include_deleted=true]
export default function campaignRoutes({ pool }) {
  const r = Router();

  r.get(
    "/",
    h(async (req, res) => {
      const includeDeleted = str(req.query.include_deleted) === "true";
      const [rows] = await pool.query(
        `SELECT campaign_id, name, status, DATE_FORMAT(created_at, ${ISO}) AS created_at
           FROM v_export_campaigns
          WHERE tenant = ? ${includeDeleted ? "" : "AND status = 'active'"}
          ORDER BY campaign_id LIMIT ${MAX_LIMIT}`,
        [req.tenant],
      );
      res.json({
        data: rows.map((c) => ({
          id: Number(c.campaign_id),
          name: c.name,
          status: c.status,
          created_at: c.created_at,
        })),
      });
    }),
  );

  return r;
}