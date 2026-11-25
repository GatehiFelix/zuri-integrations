import { Router } from "express";
import { h } from "../../api/util.js";

const agentNum = (loc) => loc.match(/\d+/)?.[0] ?? loc; // same rule as agentWatcher

// GET /v1/queue/members -> { tenant, as_of, members: [{ agent, paused, reason, seq, changed_at }] }
export default function membersRoutes({ pool }) {
  const r = Router();

  r.get(
    "/",
    h(async (req, res) => {
      const [[ep]] = await pool.query(
        "SELECT expose_agent_name FROM integration_endpoints WHERE product_id = ? AND enabled = 1 LIMIT 1",
        [req.tenant],
      );
      const exposeName = !!ep?.expose_agent_name;

      const [rows] = await pool.query(
        `SELECT location, member_name, paused, pause_reason, seq,
                UNIX_TIMESTAMP(changed_at) AS ts
           FROM integration_agent_state
          WHERE product_id = ? AND in_queue = 1
          ORDER BY location`,
        [req.tenant],
      );

      res.json({
        tenant: String(req.tenant),
        as_of: new Date().toISOString(),
        members: rows.map((m) => ({
          agent: {
            id: agentNum(m.location),
            ...(exposeName && m.member_name ? { name: m.member_name } : {}),
          },
          paused: !!m.paused,
          reason: m.pause_reason || null,
          seq: Number(m.seq),
          changed_at: new Date(Number(m.ts) * 1000).toISOString(),
        })),
      });
    }),
  );

  return r;
}