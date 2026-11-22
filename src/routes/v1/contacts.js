import { Router } from "express";
import { ApiError } from "../../errors.js";
import { encodeCursor, decodeCursor } from "../../cursor.js";
import { h, str, toIso, parseLimit, parseSince, ISO } from "../../util.js";

const DT_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

// Mounted at /v1/campaigns/:id/contacts
// Full mode  (default): live contacts only, keyset on contact id.
// Delta mode (updated_since or a delta cursor): changed rows incl. deleted:true tombstones,
//            keyset on (changed_at, contact id).
export default function contactRoutes({ pool }) {
  const r = Router({ mergeParams: true }); // gives us :id from the parent mount

  r.get(
    "/",
    h(async (req, res) => {
      if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, "not_found", "Campaign not found");
      const campaignId = Number(req.params.id);
      const limit = parseLimit(req.query.limit);

      // resolve mode + position
      let mode;
      let pos; // full: { id }   delta: { t, id }
      const rawCursor = str(req.query.cursor);
      if (req.query.cursor !== undefined && !rawCursor)
        throw new ApiError(400, "invalid_request", "Invalid cursor");

      if (rawCursor) {
        const c = decodeCursor(rawCursor);
        const idOk = c && Number.isSafeInteger(c.id) && c.id >= 0;
        if (!c || c.c !== campaignId || !idOk) throw new ApiError(400, "invalid_request", "Invalid cursor");
        if (c.m === "f") {
          mode = "full";
          pos = { id: c.id };
        } else if (c.m === "d" && typeof c.t === "string" && DT_RE.test(c.t)) {
          mode = "delta";
          pos = { t: c.t, id: c.id };
        } else {
          throw new ApiError(400, "invalid_request", "Invalid cursor");
        }
      } else if (req.query.updated_since !== undefined) {
        mode = "delta";
        pos = { t: parseSince(req.query.updated_since), id: 0 };
      } else {
        mode = "full";
        pos = { id: 0 };
      }

      // 404 for unknown / foreign campaigns; deleted campaigns only visible in delta mode
      const [crows] = await pool.query(
        "SELECT campaign_id, status FROM v_export_campaigns WHERE tenant = ? AND campaign_id = ? LIMIT 1",
        [req.tenant, campaignId],
      );
      const camp = crows[0];
      if (!camp || (camp.status === "deleted" && mode === "full"))
        throw new ApiError(404, "not_found", "Campaign not found");

      if (mode === "full") {
        const [rows] = await pool.query(
          `SELECT contact_id, msisdn,
                  DATE_FORMAT(created_at, ${ISO})  AS created_at,
                  DATE_FORMAT(actioned_at, ${ISO}) AS actioned_at
             FROM v_export_contacts
            WHERE tenant = ? AND campaign_id = ? AND is_deleted = 0 AND contact_id > ?
            ORDER BY contact_id
            LIMIT ?`,
          [req.tenant, campaignId, pos.id, limit + 1],
        );
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        const last = rows[rows.length - 1];
        return res.json({
          data: rows.map((c) => ({
            id: Number(c.contact_id),
            msisdn: c.msisdn,
            created_at: c.created_at,
            actioned_at: c.actioned_at,
          })),
          has_more: hasMore,
          next_cursor: hasMore ? encodeCursor({ m: "f", c: campaignId, id: Number(last.contact_id) }) : null,
        });
      }

      const [rows] = await pool.query(
        `SELECT contact_id, msisdn, is_deleted,
                DATE_FORMAT(created_at, ${ISO})  AS created_at,
                DATE_FORMAT(actioned_at, ${ISO}) AS actioned_at,
                DATE_FORMAT(changed_at, '%Y-%m-%d %H:%i:%s') AS changed_at
           FROM v_export_contacts
          WHERE tenant = ? AND campaign_id = ?
            AND (changed_at > ? OR (changed_at = ? AND contact_id > ?))
          ORDER BY changed_at, contact_id
          LIMIT ?`,
        [req.tenant, campaignId, pos.t, pos.t, pos.id, limit + 1],
      );
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const last = rows[rows.length - 1];
      // watermark for the NEXT sync: last changed_at seen (or where we started if nothing changed)
      const watermark = last ? last.changed_at : pos.t;
      res.json({
        data: rows.map((c) => ({
          id: Number(c.contact_id),
          msisdn: c.msisdn,
          created_at: c.created_at,
          actioned_at: c.actioned_at,
          deleted: Number(c.is_deleted) === 1,
        })),
        has_more: hasMore,
        next_cursor: hasMore
          ? encodeCursor({ m: "d", c: campaignId, t: last.changed_at, id: Number(last.contact_id) })
          : null,
        next_updated_since: toIso(watermark),
      });
    }),
  );

  return r;
}