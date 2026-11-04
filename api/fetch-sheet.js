import { requirePassword } from "./_auth.js";

// Fetches a Google Sheet's CSV export server-side (avoids browser CORS issues).
// Only works for sheets shared as "Anyone with the link can view".
// For live write-back into the sheet, use the Apps Script add-on in /apps-script instead.

function parseSheetUrl(raw) {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(raw || "");
  if (!m) return null;
  const id = m[1];
  const gidMatch = /[?&#]gid=(\d+)/.exec(raw || "");
  const gid = gidMatch ? gidMatch[1] : "0";
  return { id, gid };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!requirePassword(req, res)) return;

  const sheetUrl = String(req.query.url || "");
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) {
    res.status(400).json({ error: "Paste a valid Google Sheets URL (https://docs.google.com/spreadsheets/d/...)." });
    return;
  }

  const exportUrl = `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=csv&gid=${parsed.gid}`;

  try {
    const r = await fetch(exportUrl, { redirect: "follow" });
    if (!r.ok) {
      res.status(r.status).json({
        error: `Could not fetch the sheet (HTTP ${r.status}). Make sure it's shared as "Anyone with the link can view".`,
      });
      return;
    }
    const csv = await r.text();
    // Google returns an HTML sign-in page (not CSV) for private sheets — detect and reject that.
    if (/^\s*<!DOCTYPE html/i.test(csv) || /accounts\.google\.com/i.test(csv.slice(0, 500))) {
      res.status(403).json({
        error: 'This sheet looks private. Share it as "Anyone with the link can view" and try again.',
      });
      return;
    }
    res.status(200).json({ csv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
