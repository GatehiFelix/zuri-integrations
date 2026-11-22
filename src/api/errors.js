// One error shape for the whole API: { error: { code, message } }
export class ApiError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function notFound(_req, _res, next) {
  next(new ApiError(404, "not_found", "Not found"));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    if (err.headers) res.set(err.headers);
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  console.error(new Date().toISOString(), "[api] error:", err?.message);
  res.status(500).json({ error: { code: "internal_error", message: "Internal error" } });
}