// Ahrefs API v3 client for Domain Rating + organic traffic of referring domains.
// Tries the Batch Analysis endpoint first (one request for up to 100 domains),
// then falls back to per-domain Site Explorer calls for any domain it couldn't
// resolve (e.g. if batch analysis isn't enabled on the API plan).
// Docs: https://docs.ahrefs.com/en/api/reference/batch-analysis
//       https://docs.ahrefs.com/en/api/reference/domain-rating
//       https://docs.ahrefs.com/en/api/reference/metrics

const BATCH_URL = "https://api.ahrefs.com/v3/batch-analysis/batch-analysis";
const DOMAIN_RATING_URL = "https://api.ahrefs.com/v3/site-explorer/domain-rating";
const METRICS_URL = "https://api.ahrefs.com/v3/site-explorer/metrics";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function cleanHost(domain) {
  return String(domain || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0];
}

// Pull a numeric metric out of an Ahrefs row no matter which key name the
// response used (the v3 API has renamed a few fields across versions).
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

// One Batch Analysis call for up to 100 domains. Returns a Map<host, {domainRating, orgTraffic}>.
// Throws on a non-OK HTTP response so the caller can fall back.
async function fetchBatch({ apiKey, hosts }) {
  // Note: Batch Analysis has no `date` param (unlike domain-rating/metrics below) —
  // it always returns current metrics.
  const body = {
    select: ["domain_rating", "org_traffic"],
    targets: hosts.map((h) => ({ url: h, mode: "subdomains", protocol: "https" })),
    output: "json",
  };

  const res = await fetch(BATCH_URL, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Ahrefs batch-analysis ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  const rows = Array.isArray(data.targets) ? data.targets : Array.isArray(data.rows) ? data.rows : [];

  const map = new Map();
  for (const row of rows) {
    const host = cleanHost(row.url || row.target || row.domain);
    if (!host) continue;
    const metrics = row.metrics || row;
    const dr = pick(metrics, ["domain_rating", "domainRating"]);
    const traffic = pick(metrics, ["org_traffic", "orgTraffic", "traffic"]);
    map.set(host, {
      domainRating: dr == null ? null : Number(dr),
      orgTraffic: traffic == null ? null : Number(traffic),
      source: "batch",
    });
  }
  return map;
}

// Fallback: one Domain Rating call + one Metrics call per domain, run in parallel.
async function fetchPerDomain({ apiKey, host, date }) {
  const drUrl = `${DOMAIN_RATING_URL}?${new URLSearchParams({ target: host, date, output: "json" })}`;
  const metricsUrl = `${METRICS_URL}?${new URLSearchParams({
    target: host,
    mode: "subdomains",
    protocol: "https",
    date,
    output: "json",
  })}`;

  const [drRes, metricsRes] = await Promise.all([
    fetch(drUrl, { headers: authHeaders(apiKey) }),
    fetch(metricsUrl, { headers: authHeaders(apiKey) }),
  ]);

  let domainRating = null;
  let orgTraffic = null;
  let error = null;

  if (drRes.ok) {
    const d = await drRes.json().catch(() => ({}));
    const obj = d.domain_rating || d;
    domainRating = pick(obj, ["domain_rating", "domainRating"]);
    domainRating = domainRating == null ? null : Number(domainRating);
  } else {
    error = `domain-rating ${drRes.status}`;
  }

  if (metricsRes.ok) {
    const m = await metricsRes.json().catch(() => ({}));
    const obj = m.metrics || m;
    orgTraffic = pick(obj, ["org_traffic", "orgTraffic", "traffic"]);
    orgTraffic = orgTraffic == null ? null : Number(orgTraffic);
  } else {
    error = [error, `metrics ${metricsRes.status}`].filter(Boolean).join("; ");
  }

  return { domainRating, orgTraffic, source: "fallback", error: error || undefined };
}

// Resolve DR + organic traffic for a list of referring domains.
// Returns { metrics: Map<host, {domainRating, orgTraffic, source, error?}>, warnings: string[] }
export async function getDomainMetrics({ apiKey, domains }) {
  const date = todayISO(); // only used by the per-domain fallback endpoints
  const hosts = [...new Set(domains.map(cleanHost).filter(Boolean))];
  const metrics = new Map();
  const warnings = [];
  if (hosts.length === 0) return { metrics, warnings };

  // Batch Analysis accepts up to 100 targets per call.
  const chunks = [];
  for (let i = 0; i < hosts.length; i += 100) chunks.push(hosts.slice(i, i + 100));

  const unresolved = new Set(hosts);
  for (const chunk of chunks) {
    try {
      const batchResult = await fetchBatch({ apiKey, hosts: chunk });
      for (const [host, val] of batchResult) {
        metrics.set(host, val);
        unresolved.delete(host);
      }
    } catch (e) {
      warnings.push(e.message);
      // leave this chunk's hosts in `unresolved` so the fallback picks them up
    }
  }

  if (unresolved.size > 0) {
    const results = await Promise.all(
      [...unresolved].map((host) =>
        fetchPerDomain({ apiKey, host, date })
          .then((r) => ({ host, r }))
          .catch((e) => ({ host, r: { domainRating: null, orgTraffic: null, source: "error", error: e.message } }))
      )
    );
    for (const { host, r } of results) metrics.set(host, r);
  }

  return { metrics, warnings };
}
