import { createApp } from "./app.js";

// Mirrors startLoop(): returns an async stop function.
//   const stopApi = startApi({ pool });   // in src/index.js
export function startApi({ pool, env = process.env, log = console.log } = {}) {
  const port = Number(env.API_PORT || 3100);
  const host = env.API_HOST || "127.0.0.1"; // keep on loopback; TLS is terminated by nginx
  const rateLimit = Number(env.API_RATE_LIMIT || 60);

  const app = createApp({ pool, rateLimit });
  const server = app.listen(port, host, () =>
    log(new Date().toISOString(), `[api] listening on ${host}:${port}`),
  );
  server.on("error", (e) => console.error(new Date().toISOString(), "[api] server error:", e.message));

  return async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  };
}