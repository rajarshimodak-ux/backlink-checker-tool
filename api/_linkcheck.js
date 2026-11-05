// Checks one live backlink URL:
//  - follows redirects manually so we can report the full status chain
//  - on a final 200, scans the HTML for the target keyword, a title/page match,
//    and a real <a href> pointing at the client's website (not just a text mention)

const MAX_REDIRECTS = 6;
const TIMEOUT_MS = 20000;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

function decodeEntities(str) {
  return String(str || "").replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, k) => ENTITIES[k] ?? "");
}

function normalize(str) {
  return decodeEntities(String(str || ""))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  const withoutBlocks = String(html || "").replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  return decodeEntities(withoutBlocks.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function extractAnchors(html) {
  const anchors = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || "")) !== null) {
    anchors.push({ href: m[1].trim(), text: decodeEntities(stripTags(m[2])).trim() });
  }
  return anchors;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return String(url || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0]
      .toLowerCase();
  }
}

// Token-overlap similarity between two short strings (0..1).
function similarity(a, b) {
  const ta = new Set(normalize(a).split(" ").filter((w) => w.length > 2));
  const tb = new Set(normalize(b).split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / Math.min(ta.size, tb.size);
}

// A generic non-browser UA string gets auto-blocked by a lot of Cloudflare/WAF
// configs regardless of intent. Presenting as an ordinary desktop browser avoids
// that false-positive class of blocks for these public, already-published pages.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchManual(url, signal) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal,
    headers: BROWSER_HEADERS,
  });
  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkBacklink({ url, keyword, page, clientSite, anchorText }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const chain = [];
  let currentUrl = url;
  let finalRes = null;

  try {
    for (let i = 0; i < MAX_REDIRECTS; i++) {
      const res = await fetchManual(currentUrl, controller.signal);
      chain.push(res.status);
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
      if (isRedirect) {
        const location = res.headers.get("location");
        res.body?.cancel?.().catch(() => {});
        if (!location) {
          finalRes = res;
          break;
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      finalRes = res;
      break;
    }

    // A single retry after a short pause for 403/429 — these are sometimes a
    // transient rate-limit or a one-off bot-filter hiccup rather than a hard wall.
    if (finalRes && (finalRes.status === 403 || finalRes.status === 429)) {
      finalRes.body?.cancel?.().catch(() => {});
      await sleep(1200);
      const retryRes = await fetchManual(currentUrl, controller.signal);
      chain.push(retryRes.status);
      finalRes = retryRes;
    }

    if (!finalRes) {
      clearTimeout(timer);
      return {
        requestedUrl: url,
        finalUrl: currentUrl,
        statusLabel: chain.length ? `${chain.join(" \u2192 ")} (too many redirects)` : "TOO_MANY_REDIRECTS",
        finalStatus: chain[chain.length - 1] ?? null,
        live: false,
        pageTitle: "",
        keywordFound: "N/A",
        pageMatch: "N/A",
        clientSiteFound: "N/A",
        matchedAnchorText: "",
        anchorTextMatch: "N/A",
        error: "Too many redirects",
      };
    }

    const finalStatus = finalRes.status;
    const statusLabel = chain.length > 1 ? chain.join(" \u2192 ") : String(finalStatus);
    const live = finalStatus === 200;

    let body = "";
    if (live) {
      body = await finalRes.text().catch(() => "");
    } else {
      finalRes.body?.cancel?.().catch(() => {});
    }
    clearTimeout(timer);

    if (!live) {
      return {
        requestedUrl: url,
        finalUrl: currentUrl,
        statusLabel,
        finalStatus,
        live: false,
        pageTitle: "",
        keywordFound: "N/A",
        pageMatch: "N/A",
        clientSiteFound: "N/A",
        matchedAnchorText: "",
        anchorTextMatch: "N/A",
        error:
          finalStatus === 403 || finalStatus === 429
            ? "Site blocked automated access (bot-protection) — verify the client link manually in a browser"
            : null,
      };
    }

    const title = extractTitle(body);
    const plainText = stripTags(body);
    const anchors = extractAnchors(body);

    // Keyword check: exact phrase, else "Partial" if every significant word shows up somewhere.
    let keywordFound = "N/A";
    if (keyword && keyword.trim()) {
      const nKeyword = normalize(keyword);
      const nText = normalize(plainText) + " " + normalize(title);
      if (nKeyword && nText.includes(nKeyword)) {
        keywordFound = "Yes";
      } else {
        const words = nKeyword.split(" ").filter((w) => w.length > 2);
        keywordFound = words.length && words.every((w) => nText.includes(w)) ? "Partial" : "No";
      }
    }

    // Page/title match: substring either direction, or decent token overlap.
    let pageMatch = "N/A";
    if (page && page.trim()) {
      const nPage = normalize(page);
      const nTitle = normalize(title);
      const substr = nPage && nTitle && (nTitle.includes(nPage) || nPage.includes(nTitle));
      pageMatch = substr || similarity(page, title) >= 0.5 ? "Yes" : "No";
    }

    // Client site check: look for a real <a href> pointing at the client's domain.
    let clientSiteFound = "N/A";
    let matchedAnchorText = "";
    let anchorTextMatch = "N/A";
    if (clientSite && clientSite.trim()) {
      const clientHost = hostOf(clientSite);
      const matches = anchors.filter((a) => {
        const h = hostOf(a.href);
        return h && clientHost && (h === clientHost || h.endsWith("." + clientHost));
      });
      if (matches.length > 0) {
        clientSiteFound = "Yes";
        matchedAnchorText = matches.map((m) => m.text).filter(Boolean).join(" | ");
        if (anchorText && anchorText.trim()) {
          const nExpected = normalize(anchorText);
          anchorTextMatch = matches.some((m) => {
            const nActual = normalize(m.text);
            return nActual && (nActual === nExpected || nActual.includes(nExpected) || nExpected.includes(nActual));
          })
            ? "Yes"
            : "No";
        }
      } else if (normalize(plainText).includes(normalize(clientHost))) {
        clientSiteFound = "Mentioned only (no link)";
      } else {
        clientSiteFound = "No";
      }
    }

    return {
      requestedUrl: url,
      finalUrl: currentUrl,
      statusLabel,
      finalStatus,
      live: true,
      pageTitle: title,
      keywordFound,
      pageMatch,
      clientSiteFound,
      matchedAnchorText,
      anchorTextMatch,
      error: null,
    };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e.name === "AbortError";
    return {
      requestedUrl: url,
      finalUrl: currentUrl,
      statusLabel: aborted ? "TIMEOUT" : "ERROR",
      finalStatus: null,
      live: false,
      pageTitle: "",
      keywordFound: "N/A",
      pageMatch: "N/A",
      clientSiteFound: "N/A",
      matchedAnchorText: "",
      anchorTextMatch: "N/A",
      error: aborted ? `Timed out after ${TIMEOUT_MS}ms` : e.message,
    };
  }
}
