/**
 * Backlink Checker (Google Apps Script, bound to a Google Sheet)
 *
 * INPUT  : the ACTIVE sheet, with (at least) a "Backlink URL" column, plus
 *          whichever of these you have: Domain, Page, Keyword, BL Website,
 *          Anchor Text. Column order doesn't matter — matched by header name.
 * DOES   : 1) Fetches every live Backlink URL (follows redirects, in parallel
 *             batches) and records the HTTP status code / chain.
 *          2) On a live (200) page, checks whether the Keyword and the Page
 *             title actually appear, and whether the BL Website is present
 *             as a real <a href> link (not just a text mention).
 *          3) Looks up current Domain Rating + organic traffic for every
 *             unique referring domain via the Ahrefs API v3 (Batch Analysis,
 *             falling back to per-domain Site Explorer calls).
 * OUTPUT : writes new columns back into the same sheet (created if missing):
 *          Status Code, Keyword Found, Page Match, Client Site Linked,
 *          Anchor Match, Referring Domain DR, Referring Domain Traffic,
 *          Quality, Notes, Checked At.
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP
 *   1. Open the sheet -> Extensions -> Apps Script -> paste this file -> Save.
 *   2. Reload the sheet. A "Backlink Tools" menu appears.
 *   3. Backlink Tools -> "Set Ahrefs API key" -> paste your Ahrefs API v3 key.
 *      (Stored in Script Properties, NOT in this file.)
 *
 * USAGE
 *   - Open the tab with your backlink tracker, make sure it has a
 *     "Backlink URL" column (plus Domain / Page / Keyword / BL Website /
 *     Anchor Text if you want the content checks).
 *   - Backlink Tools -> "Check backlinks on this sheet".
 * ---------------------------------------------------------------------------
 */

var CFG = {
  PROP_AHREFS: 'AHREFS_API_KEY',
  MIN_DR: 30,
  MIN_TRAFFIC: 500,
  MAX_REDIRECT_HOPS: 5,
  FETCH_BATCH_SIZE: 40,   // requests per UrlFetchApp.fetchAll() call
  AHREFS_BATCH_SIZE: 100, // domains per Ahrefs batch-analysis call
  OUTPUT_COLUMNS: [
    'Status Code', 'Keyword Found', 'Page Match', 'Client Site Linked',
    'Anchor Match', 'Referring Domain DR', 'Referring Domain Traffic',
    'Quality', 'Notes', 'Checked At'
  ]
};

// =========================
// MENU + SETUP
// =========================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Backlink Tools')
    .addItem('Check backlinks on this sheet', 'checkBacklinksOnActiveSheet')
    .addSeparator()
    .addItem('Set Ahrefs API key', 'setupApiKeys')
    .addToUi();
}

function setupApiKeys() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var r = ui.prompt('Ahrefs API v3 key', 'Paste your Ahrefs API key (blank = keep current):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var key = r.getResponseText().trim();
  if (key) props.setProperty(CFG.PROP_AHREFS, key);
  ui.alert('Saved. The key is stored in Script Properties.');
}

// =========================
// MAIN ENTRY POINT
// =========================
function checkBacklinksOnActiveSheet() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length < 2) { ui.alert('No data rows found.'); return; }

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var colIndex = function (name) {
    var target = name.trim().toLowerCase();
    for (var i = 0; i < headers.length; i++) if (headers[i].toLowerCase() === target) return i;
    return -1;
  };

  var backlinkCol = colIndex('Backlink URL');
  if (backlinkCol === -1) { ui.alert('Could not find a "Backlink URL" column on this sheet.'); return; }
  var domainCol = colIndex('Domain');
  var pageCol = colIndex('Page');
  var keywordCol = colIndex('Keyword');
  var blSiteCol = colIndex('BL Website');
  var anchorCol = colIndex('Anchor Text');

  // Ensure output columns exist (append any missing ones), track their indices.
  var outCol = {};
  var lastCol = headers.length;
  CFG.OUTPUT_COLUMNS.forEach(function (name) {
    var idx = colIndex(name);
    if (idx === -1) {
      lastCol += 1;
      sheet.getRange(1, lastCol).setValue(name);
      idx = lastCol - 1;
      headers[idx] = name;
    }
    outCol[name] = idx;
  });

  // Build row descriptors (1-indexed sheet row = i+2).
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    var backlinkUrl = String(v[backlinkCol] || '').trim();
    if (!backlinkUrl) continue;
    if (!/^https?:\/\//i.test(backlinkUrl)) backlinkUrl = 'https://' + backlinkUrl;
    rows.push({
      sheetRow: i + 1,
      backlinkUrl: backlinkUrl,
      domain: domainCol > -1 ? String(v[domainCol] || '').trim() : '',
      page: pageCol > -1 ? String(v[pageCol] || '').trim() : '',
      keyword: keywordCol > -1 ? String(v[keywordCol] || '').trim() : '',
      blWebsite: blSiteCol > -1 ? String(v[blSiteCol] || '').trim() : '',
      anchorText: anchorCol > -1 ? String(v[anchorCol] || '').trim() : ''
    });
  }
  if (rows.length === 0) { ui.alert('No rows with a Backlink URL to check.'); return; }

  // 1) Resolve live status + content checks for every row (parallel, round-based redirects).
  var checks = resolveBacklinks_(rows);

  // 2) Resolve DR + traffic for every unique referring domain.
  var hosts = {};
  rows.forEach(function (r) { var h = hostOf_(r.domain || r.backlinkUrl); if (h) hosts[h] = true; });
  var apiKey = PropertiesService.getScriptProperties().getProperty(CFG.PROP_AHREFS);
  var domainMetrics = apiKey ? getDomainMetrics_(apiKey, Object.keys(hosts)) : {};

  // 3) Write results back.
  var now = new Date();
  rows.forEach(function (r, idx) {
    var c = checks[idx];
    var host = hostOf_(r.domain || r.backlinkUrl);
    var m = domainMetrics[host] || {};
    var quality = qualityLabel_(m.domainRating, m.orgTraffic);
    var out = [];
    out[outCol['Status Code']] = c.statusLabel;
    out[outCol['Keyword Found']] = c.keywordFound;
    out[outCol['Page Match']] = c.pageMatch;
    out[outCol['Client Site Linked']] = c.clientSiteFound;
    out[outCol['Anchor Match']] = c.anchorTextMatch;
    out[outCol['Referring Domain DR']] = m.domainRating == null ? '' : m.domainRating;
    out[outCol['Referring Domain Traffic']] = m.orgTraffic == null ? '' : m.orgTraffic;
    out[outCol['Quality']] = quality;
    out[outCol['Notes']] = c.error || c.matchedAnchorText || '';
    out[outCol['Checked At']] = now;

    CFG.OUTPUT_COLUMNS.forEach(function (name) {
      sheet.getRange(r.sheetRow, outCol[name] + 1).setValue(out[outCol[name]]);
    });
  });

  ui.alert('Done. Checked ' + rows.length + ' backlink(s).');
}

function qualityLabel_(dr, traffic) {
  if (dr == null) return 'Unknown';
  if (dr >= CFG.MIN_DR && (traffic == null || traffic >= CFG.MIN_TRAFFIC)) return 'Good';
  if (dr >= CFG.MIN_DR / 2) return 'Average';
  return 'Low';
}

// =========================
// LIVE LINK + CONTENT CHECKS
// =========================

// Round-based redirect resolution for many URLs at once via UrlFetchApp.fetchAll.
function resolveBacklinks_(rows) {
  var n = rows.length;
  var state = rows.map(function (r) {
    return { url: r.backlinkUrl, chain: [], done: false, finalStatus: null, content: '', error: null };
  });

  for (var hop = 0; hop <= CFG.MAX_REDIRECT_HOPS; hop++) {
    var pendingIdx = [];
    for (var i = 0; i < n; i++) if (!state[i].done) pendingIdx.push(i);
    if (pendingIdx.length === 0) break;

    for (var b = 0; b < pendingIdx.length; b += CFG.FETCH_BATCH_SIZE) {
      var batchIdx = pendingIdx.slice(b, b + CFG.FETCH_BATCH_SIZE);
      var requests = batchIdx.map(function (idx) {
        return { url: state[idx].url, method: 'get', followRedirects: false, muteHttpExceptions: true,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacklinkChecker/1.0)' } };
      });
      var responses;
      try {
        responses = UrlFetchApp.fetchAll(requests);
      } catch (e) {
        batchIdx.forEach(function (idx) { state[idx].done = true; state[idx].error = e.message; state[idx].chain.push('ERROR'); });
        continue;
      }
      batchIdx.forEach(function (idx, j) {
        var res = responses[j];
        var code = res.getResponseCode();
        state[idx].chain.push(code);
        if ([301, 302, 303, 307, 308].indexOf(code) > -1 && hop < CFG.MAX_REDIRECT_HOPS) {
          var headers = res.getHeaders();
          var location = headers['Location'] || headers['location'];
          if (location) {
            state[idx].url = resolveUrl_(state[idx].url, location);
            return; // still pending, next hop will fetch it
          }
        }
        state[idx].done = true;
        state[idx].finalStatus = code;
        if (code === 200) state[idx].content = res.getContentText();
      });
    }
  }
  // Anything still not done after MAX_REDIRECT_HOPS = too many redirects.
  state.forEach(function (s) {
    if (!s.done) { s.finalStatus = s.chain[s.chain.length - 1] || null; s.error = s.error || 'Too many redirects'; }
  });

  return rows.map(function (r, idx) { return buildCheckResult_(r, state[idx]); });
}

function resolveUrl_(base, location) {
  try {
    if (/^https?:\/\//i.test(location)) return location;
    var baseUrl = base.match(/^(https?:\/\/[^\/]+)/i);
    if (location.indexOf('/') === 0) return (baseUrl ? baseUrl[1] : '') + location;
    return base.replace(/\/[^\/]*$/, '/') + location;
  } catch (e) { return location; }
}

function buildCheckResult_(row, s) {
  var statusLabel = s.error && s.chain.length === 0
    ? (s.error === 'Too many redirects' ? s.chain.join(' \u2192 ') + ' (too many redirects)' : 'ERROR')
    : s.chain.length > 1 ? s.chain.join(' \u2192 ') : String(s.chain[0] || s.finalStatus || 'ERROR');
  var live = s.finalStatus === 200;

  var result = {
    statusLabel: statusLabel,
    finalStatus: s.finalStatus,
    live: live,
    keywordFound: 'N/A',
    pageMatch: 'N/A',
    clientSiteFound: 'N/A',
    anchorTextMatch: 'N/A',
    matchedAnchorText: '',
    error: s.error || null
  };
  if (!live) return result;

  var title = extractTitle_(s.content);
  var plainText = stripTags_(s.content);
  var anchors = extractAnchors_(s.content);

  if (row.keyword) {
    var nKeyword = normalize_(row.keyword);
    var nText = normalize_(plainText) + ' ' + normalize_(title);
    if (nKeyword && nText.indexOf(nKeyword) > -1) {
      result.keywordFound = 'Yes';
    } else {
      var words = nKeyword.split(' ').filter(function (w) { return w.length > 2; });
      result.keywordFound = words.length && words.every(function (w) { return nText.indexOf(w) > -1; }) ? 'Partial' : 'No';
    }
  }

  if (row.page) {
    var nPage = normalize_(row.page);
    var nTitle = normalize_(title);
    var substr = nPage && nTitle && (nTitle.indexOf(nPage) > -1 || nPage.indexOf(nTitle) > -1);
    result.pageMatch = (substr || similarity_(row.page, title) >= 0.5) ? 'Yes' : 'No';
  }

  if (row.blWebsite) {
    var clientHost = hostOf_(row.blWebsite);
    var matches = anchors.filter(function (a) {
      var h = hostOf_(a.href);
      return h && clientHost && (h === clientHost || h.indexOf('.' + clientHost) === h.length - clientHost.length - 1);
    });
    if (matches.length > 0) {
      result.clientSiteFound = 'Yes';
      result.matchedAnchorText = matches.map(function (m) { return m.text; }).filter(Boolean).join(' | ');
      if (row.anchorText) {
        var nExpected = normalize_(row.anchorText);
        result.anchorTextMatch = matches.some(function (m) {
          var nActual = normalize_(m.text);
          return nActual && (nActual === nExpected || nActual.indexOf(nExpected) > -1 || nExpected.indexOf(nActual) > -1);
        }) ? 'Yes' : 'No';
      }
    } else if (normalize_(plainText).indexOf(normalize_(clientHost)) > -1) {
      result.clientSiteFound = 'Mentioned only (no link)';
    } else {
      result.clientSiteFound = 'No';
    }
  }

  return result;
}

// ---- tiny HTML helpers (no external libs available in Apps Script) ----
var ENTITIES_ = { 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', '#39': "'", 'apos': "'", 'nbsp': ' ' };
function decodeEntities_(str) {
  return String(str || '').replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, function (_, k) { return ENTITIES_[k] || ''; });
}
function normalize_(str) {
  return decodeEntities_(String(str || '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripTags_(html) {
  var noBlocks = String(html || '').replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities_(noBlocks.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function extractTitle_(html) {
  var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? decodeEntities_(m[1]).replace(/\s+/g, ' ').trim() : '';
}
function extractAnchors_(html) {
  var anchors = [];
  var re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html || '')) !== null) {
    anchors.push({ href: m[1].trim(), text: decodeEntities_(stripTags_(m[2])).trim() });
  }
  return anchors;
}
function hostOf_(url) {
  var s = String(url || '').trim();
  if (!s) return '';
  var m = /^https?:\/\/([^\/]+)/i.exec(s);
  var host = m ? m[1] : s.split('/')[0];
  return host.replace(/^www\./i, '').toLowerCase();
}
function similarity_(a, b) {
  var ta = {}, tb = {};
  normalize_(a).split(' ').forEach(function (w) { if (w.length > 2) ta[w] = true; });
  normalize_(b).split(' ').forEach(function (w) { if (w.length > 2) tb[w] = true; });
  var ka = Object.keys(ta), kb = Object.keys(tb);
  if (ka.length === 0 || kb.length === 0) return 0;
  var overlap = 0;
  ka.forEach(function (w) { if (tb[w]) overlap++; });
  return overlap / Math.min(ka.length, kb.length);
}

// =========================
// AHREFS API v3 (Domain Rating + organic traffic)
// =========================
function getDomainMetrics_(apiKey, hosts) {
  hosts = hosts.filter(Boolean);
  var metrics = {};
  if (hosts.length === 0) return metrics;
  var date = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

  var unresolved = hosts.slice();
  for (var b = 0; b < hosts.length; b += CFG.AHREFS_BATCH_SIZE) {
    var chunk = hosts.slice(b, b + CFG.AHREFS_BATCH_SIZE);
    try {
      // Note: Batch Analysis has no `date` param (unlike the fallback endpoints below).
      var payload = {
        select: ['domain_rating', 'org_traffic'],
        targets: chunk.map(function (h) { return { url: h, mode: 'subdomains', protocol: 'https' }; }),
        output: 'json'
      };
      var res = UrlFetchApp.fetch('https://api.ahrefs.com/v3/batch-analysis/batch-analysis', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(payload),
        headers: { Authorization: 'Bearer ' + apiKey }, muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) throw new Error('batch-analysis HTTP ' + res.getResponseCode());
      var data = JSON.parse(res.getContentText() || '{}');
      var targets = data.targets || data.rows || [];
      targets.forEach(function (row) {
        var host = hostOf_(row.url || row.target || row.domain);
        if (!host) return;
        var m = row.metrics || row;
        metrics[host] = {
          domainRating: m.domain_rating != null ? Number(m.domain_rating) : null,
          orgTraffic: m.org_traffic != null ? Number(m.org_traffic) : null
        };
        unresolved = unresolved.filter(function (h) { return h !== host; });
      });
    } catch (e) {
      // leave this chunk's hosts in `unresolved`; fallback handles them below
    }
  }

  unresolved.forEach(function (host) {
    metrics[host] = getDomainMetricsFallback_(apiKey, host, date);
  });

  return metrics;
}

function getDomainMetricsFallback_(apiKey, host, date) {
  var result = { domainRating: null, orgTraffic: null };
  try {
    var drRes = UrlFetchApp.fetch(
      'https://api.ahrefs.com/v3/site-explorer/domain-rating?' + buildQuery_({ target: host, date: date, output: 'json' }),
      { headers: { Authorization: 'Bearer ' + apiKey }, muteHttpExceptions: true }
    );
    if (drRes.getResponseCode() === 200) {
      var d = JSON.parse(drRes.getContentText() || '{}');
      var obj = d.domain_rating || d;
      result.domainRating = obj.domain_rating != null ? Number(obj.domain_rating) : null;
    }
  } catch (e) { /* leave null */ }
  try {
    var mRes = UrlFetchApp.fetch(
      'https://api.ahrefs.com/v3/site-explorer/metrics?' + buildQuery_({ target: host, mode: 'subdomains', protocol: 'https', date: date, output: 'json' }),
      { headers: { Authorization: 'Bearer ' + apiKey }, muteHttpExceptions: true }
    );
    if (mRes.getResponseCode() === 200) {
      var m = JSON.parse(mRes.getContentText() || '{}');
      var mobj = m.metrics || m;
      result.orgTraffic = mobj.org_traffic != null ? Number(mobj.org_traffic) : null;
    }
  } catch (e) { /* leave null */ }
  return result;
}

function buildQuery_(params) {
  return Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}
