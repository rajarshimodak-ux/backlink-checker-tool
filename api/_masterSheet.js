import { createSign } from "node:crypto";

// Cross-checks uploaded live links against the "Master Live Links" Google Sheet
// of previously-paid backlinks, to catch vendors re-submitting an already-paid
// link for duplicate payment. Reads via a Google service account (no npm deps —
// RS256 JWT signing with Node's built-in crypto, exchanged for an OAuth2 token).

const DEFAULT_SHEET_ID = "1lzxQHnKMkWZVdckAALrp3ySzn0SrDaQkU0qxTehzZxM";
const DEFAULT_RANGE = "Master!B2:E13000"; // Client Name (B) .. Live URL (E); sheet has ~12.5k rows
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { map: null, builtAt: 0, warning: null };

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Mirrors the frontend's normalizeLink(): trims, drops trailing slash(es), and
// lowercases host+path, so "...page/" and "...page" are treated as the same link.
export function normalizeLink(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(s);
    return (u.hostname.replace(/^www\./i, "") + u.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

async function getAccessToken({ email, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

async function fetchMasterRows({ accessToken, sheetId, range }) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google Sheets read failed: ${data.error?.message || res.status}`);
  }
  return Array.isArray(data.values) ? data.values : [];
}

// Returns { map, warning } where map is Map<normalizedLink, clientName>.
// Cached in-process for CACHE_TTL_MS so repeated row-chunks in the same run
// (and nearby requests) don't re-hit the Sheets API.
export async function getMasterPaidLinks() {
  if (cache.map && Date.now() - cache.builtAt < CACHE_TTL_MS) {
    return { map: cache.map, warning: cache.warning };
  }

  const email = process.env.GOOGLE_SA_EMAIL;
  const privateKey = (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const sheetId = process.env.MASTER_SHEET_ID || DEFAULT_SHEET_ID;
  const range = process.env.MASTER_SHEET_RANGE || DEFAULT_RANGE;

  if (!email || !privateKey) {
    const warning = "Master-sheet duplicate check skipped — GOOGLE_SA_EMAIL/GOOGLE_SA_PRIVATE_KEY not set on the server.";
    cache = { map: new Map(), builtAt: Date.now(), warning };
    return { map: cache.map, warning };
  }

  try {
    const accessToken = await getAccessToken({ email, privateKey });
    const rows = await fetchMasterRows({ accessToken, sheetId, range });
    const map = new Map();
    for (const row of rows) {
      const clientName = String(row[0] || "").trim(); // column B
      const liveUrl = String(row[3] || "").trim(); // column E
      const key = normalizeLink(liveUrl);
      if (key) map.set(key, clientName);
    }
    cache = { map, builtAt: Date.now(), warning: null };
    return { map, warning: null };
  } catch (e) {
    const warning = `Master-sheet duplicate check failed: ${e.message}`;
    cache = { map: new Map(), builtAt: Date.now(), warning };
    return { map: cache.map, warning };
  }
}
