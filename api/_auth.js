import { timingSafeEqual } from "node:crypto";

// Shared-password gate. The browser sends the password in the `x-app-password`
// header on every request; we compare it to APP_PASSWORD in constant time.
// Defaults to "gushwork" if APP_PASSWORD isn't set, so the tool works out of the
// box; override by setting APP_PASSWORD in the Vercel project env.
export function requirePassword(req, res) {
  const expected = process.env.APP_PASSWORD || "gushwork";
  const provided = String(req.headers["x-app-password"] || "");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ error: "Incorrect or missing password.", code: "BAD_PASSWORD" });
    return false;
  }
  return true;
}
