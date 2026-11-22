import express from "express";
import { makeAuth, makeRateLimit } from "./auth.js";
import { notFound, errorHandler } from "./errors.js";
import v1Routes from "./routes/v1/index.js";

// App wiring only: no route logic lives here.
export function createApp({ pool, rateLimit = 60, now } = {}) {
  const app = express();
  app.disable("x-powered-by");

  // One auth + one rate limiter instance shared by every API version,
  // so the limit is per key, not per version.
  const guard = [makeAuth(pool), makeRateLimit({ limit: rateLimit, now })];

  app.use("/v1", ...guard, v1Routes({ pool }));
  // future: app.use("/v2", ...guard, v2Routes({ pool }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}