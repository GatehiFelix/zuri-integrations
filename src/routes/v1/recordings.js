import { Router } from "express";
import { existsSync } from "node:fs";
import { h } from "../../api/util.js";
import { wavStat, openWav, ensureMp3, mp3Path } from "../../lib/recordings.js";

const ID_RE = /^[0-9a-f]{24}$/;
const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });

// single range only; absent or multi-range -> whole file
function parseRange(hdr, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(hdr || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!n) return { bad: true };
    start = Math.max(size - n, 0); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return { bad: true };
  return { start, end };
}

// GET /v1/recordings/:id?format=mp3|wav   (default mp3)
export default function recordingsRoutes({ pool }) {
  const r = Router();

  r.get(
    "/:id",
    h(async (req, res) => {
      const id = req.params.id;
      const format = String(req.query.format || "mp3").toLowerCase();
      if (!["mp3", "wav"].includes(format)) return err(res, 400, "invalid_format", "format must be mp3 or wav");
      if (!ID_RE.test(id)) return err(res, 404, "not_found", "Recording not found");

      // tenant check: a recording that belongs to another tenant is indistinguishable from a missing one
      const [[rec]] = await pool.query(
        "SELECT id, call_id, rel_path, status FROM integration_recordings WHERE id = ? AND product_id = ? LIMIT 1",
        [id, req.tenant],
      );
      if (!rec) return err(res, 404, "not_found", "Recording not found");

      res.on("finish", () => {
        pool
          .query(
            "INSERT INTO integration_recording_access (recording_id, product_id, ip, format, http_status) VALUES (?,?,?,?,?)",
            [id, req.tenant, String(req.get("x-real-ip") || req.ip || "").slice(0, 45), format, res.statusCode],
          )
          .catch(() => {});
      });

      const gone = async () => {
        await pool.query("UPDATE integration_recordings SET status = 'gone' WHERE id = ?", [id]).catch(() => {});
        return err(res, 410, "gone", "Recording is no longer available");
      };
      if (rec.status === "gone") return err(res, 410, "gone", "Recording is no longer available");

      const safe = String(rec.call_id).replace(/[^A-Za-z0-9._-]/g, "_");
      res.set("Cache-Control", "private, max-age=3600");

      // ---- mp3: transcode once into the cache, then serve the local file (Range/ETag/HEAD handled by sendFile)
      if (format === "mp3") {
        const file = mp3Path(id);
        if (!existsSync(file)) {
          let st;
          try { st = await wavStat(rec.rel_path); }
          catch (e) { console.error("[rec] stat failed:", e.message); return err(res, 502, "storage_unavailable", "Recording storage unreachable, retry"); }
          if (!st) return gone();
          try { await ensureMp3(id, rec.rel_path); }
          catch (e) {
            if (e.code === "busy") { res.set("Retry-After", "5"); return err(res, 503, "busy", "Transcoder busy, retry shortly"); }
            console.error("[rec] transcode failed:", e.message);
            return err(res, 502, "transcode_failed", "Could not prepare the recording, retry");
          }
        }
        return res.sendFile(
          file,
          { headers: { "Content-Disposition": `inline; filename="${safe}.mp3"` }, acceptRanges: true },
          (e) => { if (e && !res.headersSent) err(res, 500, "internal", "Could not read recording"); },
        );
      }

      // ---- wav: stream from the PBX over SFTP, with Range
      let st;
      try { st = await wavStat(rec.rel_path); }
      catch (e) { console.error("[rec] stat failed:", e.message); return err(res, 502, "storage_unavailable", "Recording storage unreachable, retry"); }
      if (!st) return gone();

      const size = Number(st.size);
      const etag = `"${id}-${size}-${st.mtime}"`;
      res.set({
        "Accept-Ranges": "bytes", ETag: etag, "Content-Type": "audio/wav",
        "Content-Disposition": `inline; filename="${safe}.wav"`,
      });
      if (req.get("if-none-match") === etag) return res.status(304).end();

      const rg = parseRange(req.get("range"), size);
      if (rg?.bad) { res.set("Content-Range", `bytes */${size}`); return err(res, 416, "range_not_satisfiable", "Invalid range"); }
      let status = 200, start = 0, end = size - 1;
      if (rg) { status = 206; ({ start, end } = rg); res.set("Content-Range", `bytes ${start}-${end}/${size}`); }
      res.status(status).set("Content-Length", String(Math.max(end - start + 1, 0)));
      if (req.method === "HEAD" || size === 0) return res.end();

      const stream = await openWav(rec.rel_path, { start, end });
      res.on("close", () => stream.destroy());
      stream.on("error", (e) => { console.error("[rec] stream error:", e.message); res.destroy(e); });
      stream.pipe(res);
    }),
  );

  return r;
}