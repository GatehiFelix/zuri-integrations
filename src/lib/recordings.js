import ssh2 from "ssh2";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const { Client } = ssh2;
const BASE = process.env.REC_BASE || "/var/spool/asterisk/monitor";
const CACHE = process.env.REC_CACHE || "/home/zuri-int-cache/rec";
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const MAX_JOBS = Number(process.env.REC_MAX_TRANSCODES || 2);
export const NAME_RE = /^[A-Za-z0-9._+-]{1,200}\.wav$/i;
export const REL_RE = /^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._+-]{1,200}\.wav$/i;
const pad = (n) => String(n).padStart(2, "0");

let sftpP = null;
function getSftp() {
  if (sftpP) return sftpP;
  sftpP = new Promise((resolve, reject) => {
    const c = new Client();
    const reset = () => { sftpP = null; };
    c.on("ready", () => c.sftp((err, s) => (err ? (reset(), reject(err)) : resolve(s))));
    c.on("error", (e) => { reset(); reject(e); });
    c.on("close", reset);
    c.connect({
      host: process.env.REC_SSH_HOST, port: Number(process.env.REC_SSH_PORT || 22),
      username: process.env.REC_SSH_USER, privateKey: readFileSync(process.env.REC_SSH_KEY),
      readyTimeout: 10000, keepaliveInterval: 15000,
    });
  });
  return sftpP;
}
const stat = (s, p) => new Promise((res, rej) => s.stat(p, (e, st) => (e ? (e.code === 2 ? res(null) : rej(e)) : res(st))));

function candidateDirs(name, startEpoch) {
  const out = [];
  const m = /-(\d{4})(\d{2})(\d{2})-\d{6}-/.exec(name);       // date inside the filename = PBX-local call start
  if (m) out.push(`${m[1]}/${m[2]}/${m[3]}`);
  const off = Number(process.env.REC_TZ_OFFSET_MIN ?? 180) * 60;
  for (const d of [0, -86400, 86400]) {                        // fallback: cdr calldate, +-1 day (midnight edge)
    const t = new Date((startEpoch + off + d) * 1000);
    out.push(`${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`);
  }
  return [...new Set(out)];
}

export async function locate(name, startEpoch) {
  if (!NAME_RE.test(name)) return null;
  const s = await getSftp();
  for (const dir of candidateDirs(name, startEpoch)) {
    const rel = `${dir}/${name}`;
    const st = await stat(s, `${BASE}/${rel}`);
    if (st) return { rel, size: Number(st.size), mtime: Number(st.mtime) };
  }
  return null;
}

export async function wavStat(rel) {
  if (!REL_RE.test(rel)) return null;
  return stat(await getSftp(), `${BASE}/${rel}`);
}
export async function openWav(rel, range) {
  if (!REL_RE.test(rel)) throw new Error("bad path");
  const s = await getSftp();
  return s.createReadStream(`${BASE}/${rel}`, range ? { start: range.start, end: range.end } : {});
}

export const mp3Path = (id) => join(CACHE, `${id}.mp3`);
const inflight = new Map();
export async function ensureMp3(id, rel) {
  const out = mp3Path(id);
  if (existsSync(out)) return out;
  if (inflight.has(id)) return inflight.get(id);
  if (inflight.size >= MAX_JOBS) { const e = new Error("busy"); e.code = "busy"; throw e; }
  mkdirSync(CACHE, { recursive: true });
  const p = (async () => {
    const tmp = `${out}.${process.pid}.tmp`;
    const src = await openWav(rel);
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
          "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", "-y", tmp], { stdio: ["pipe", "ignore", "pipe"] });
        let err = "";
        ff.stderr.on("data", (d) => (err += d));
        ff.stdin.on("error", () => {});
        src.on("error", (e) => { ff.kill("SIGKILL"); reject(e); });
        ff.on("error", reject);
        ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
        src.pipe(ff.stdin);
      });
      renameSync(tmp, out);
    } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
    return out;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}