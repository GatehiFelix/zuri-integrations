import { Router } from "express";
import { ApiError } from "../../errors.js";
import { encodeCursor, decodeCursor } from "../../cursor.js";
import { h, str, parseLimit, ISO } from "../../util.js";

export default function pendingRoutes({ pool }) {
  const r = Router();
  r.get("/", h(async (req, res) => {
    const limit = parseLimit(req.query.limit);
    let afterId = 0;
    const raw = str(req.query.cursor);
    if (req.query.cursor !== undefined && !raw) throw new ApiError(400, "invalid_request", "Invalid cursor");
    if (raw) {
      const c = decodeCursor(raw);
      if (!c || c.m !== "p" || !Number.isSafeInteger(c.id) || c.id < 0)
        throw new ApiError(400, "invalid_request", "Invalid cursor");
      afterId = c.id;
    }
    const [rows] = await pool.query(
      `SELECT c.contact_id, c.msisdn, c.campaign_id, k.name AS campaign_name,
              DATE_FORMAT(c.created_at, ${ISO}) AS created_at
         FROM v_export_contacts c
         JOIN v_export_campaigns k ON k.campaign_id = c.campaign_id AND k.tenant = c.tenant
        WHERE c.tenant = ? AND c.is_deleted = 0 AND c.actioned_at IS NULL
          AND c.contact_id > ?
          AND c.created_at < NOW() - INTERVAL 60 SECOND
        ORDER BY c.contact_id
        LIMIT ?`,
      [req.tenant, afterId, limit + 1],
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const last = rows[rows.length - 1];
    const tail = last ? Number(last.contact_id) : afterId;
    res.json({
      data: rows.map((c) => ({
        id: Number(c.contact_id),
        msisdn: c.msisdn,
        created_at: c.created_at,
        campaign: { id: Number(c.campaign_id), name: c.campaign_name },
      })),
      has_more: hasMore,
      next_cursor: encodeCursor({ m: "p", id: tail }),
    });
  }));
  return r;
}