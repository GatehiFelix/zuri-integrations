// Opaque cursor: base64url(JSON). Clients must treat it as a black box.
export function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

export function decodeCursor(str) {
  try {
    const obj = JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}