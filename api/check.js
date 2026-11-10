import { requirePassword } from "./_auth.js";
import { checkBacklink } from "./_linkcheck.js";
import { getDomainMetrics } from "./_ahrefs.js";

export const config = { api: { bodyParser: { sizeLimit: "5mb" } } };

const CONCURRENCY = 8;

// Case-insensitive, whitespace-tolerant header lookup so the tool survives
// minor header variations in the source sheet (e.g. "BL website" vs "BL Website").
function field(row, ...names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const target = name.trim().toLowerCase();
    const key = keys.find((k) => k.trim().toLowerCase() === target);
    if (key != null && row[key] != null && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return "";
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function hostFromDomainOrUrl(domain, url) {
  const raw = domain || url || "";
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    /* fall through */
  }
  return String(raw).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!requirePassword(req, res)) return;

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const domainsNeeded = Array.isArray(body?.domainsNeeded) ? body.domainsNeeded : [];
  // Set to false when the client already resolved referring-domain metrics in a
  // separate bulk call, so repeated domains across row-chunks don't re-hit Ahrefs.
  const resolveRowDomains = body?.resolveRowDomains !== false;

  // Note: an empty { rows: [], domainsNeeded: [] } body is a valid no-op request
  // (the frontend uses it as an auth ping after the password gate) — it just
  // returns empty results rather than erroring.

  // --- Live link checks (status code, keyword/page/client-site detection) ---
  const results = await mapLimit(rows, CONCURRENCY, async (row) => {
    const backlinkUrl = field(row, "Backlink URL", "Live URL", "Live Link");
    const domain = field(row, "Domain");
    const page = field(row, "Page");
    const keyword = field(row, "Keyword");
    const blWebsite = field(row, "Client", "Client Name", "BL Website", "Client Website", "Client URL", "Client Website URL", "Client Domain");
    const anchorText = field(row, "Anchor Text");

    if (!backlinkUrl) {
      return { ...row, _check: { error: "Missing Backlink URL", statusLabel: "SKIPPED" } };
    }

    let urlToCheck = backlinkUrl;
    if (!/^https?:\/\//i.test(urlToCheck)) urlToCheck = `https://${urlToCheck}`;

    const check = await checkBacklink({ url: urlToCheck, keyword, page, clientSite: blWebsite, anchorText });
    return { ...row, _check: check, _referringHost: hostFromDomainOrUrl(domain, backlinkUrl) };
  });

  // --- Domain Rating + organic traffic for referring domains ---
  const hostsToResolve = new Set(domainsNeeded.map((d) => String(d).trim()).filter(Boolean));
  if (resolveRowDomains) {
    for (const r of results) if (r._referringHost) hostsToResolve.add(r._referringHost);
  }

  let domainMetrics = {};
  let ahrefsWarnings = [];
  if (hostsToResolve.size > 0) {
    const apiKey = process.env.AHREFS_API_KEY;
    if (!apiKey) {
      ahrefsWarnings.push("AHREFS_API_KEY is not set on the server — DR/traffic skipped.");
    } else {
      try {
        const { metrics, warnings } = await getDomainMetrics({ apiKey, domains: [...hostsToResolve] });
        domainMetrics = Object.fromEntries(metrics);
        ahrefsWarnings = warnings;
      } catch (e) {
        ahrefsWarnings.push(e.message);
      }
    }
  }

  res.status(200).json({ results, domainMetrics, ahrefsWarnings });
}
