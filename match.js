// Pure logic for the fuel-bill splitter: CSV parsing, invoice field
// extraction, and matching fuel uplifts to flight legs. No DOM access, so the
// same file runs in the page and under node for the test suite.
(function (global) {
  "use strict";

  // ---------- CSV ----------

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    // Drop rows that are entirely empty (trailing newlines, spacer rows).
    return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  }

  // Guess which columns in an Airplane Manager (or similar) export hold each
  // field. Returns indices, -1 when no candidate is found.
  function detectColumns(header) {
    const cells = header.map((h) => h.toLowerCase().trim());
    function find(patterns, exclude) {
      for (const p of patterns) {
        for (let i = 0; i < cells.length; i++) {
          if (p.test(cells[i]) && !(exclude && exclude.test(cells[i]))) return i;
        }
      }
      return -1;
    }
    const notTime = /time|eta|etd|hrs|hours/;
    return {
      date: find([/^date$/, /flight date|dep.*date|departure date|trip date/, /date/], notTime),
      tail: find([/^tail/, /tail|aircraft|reg(istration)?$|n[ -]?number/], /type|model/),
      from: find([/^from$/, /^orig/, /origin|depart(?!.*time)/], notTime),
      to: find([/^to$/, /^dest/, /destination|arriv(?!.*time)/], notTime),
      owner: find([/owner/, /client|customer|account|charter|lessee/, /passenger|pax(?!.*count)|lead|name/], /count|#|no\./),
      time: find([/flight.?time|block.?time|duration|hobbs/, /total.?time/, /\b(hrs|hours)\b/], /dep|arr|etd|eta|sched|out\b|off\b|on\b|in\b|local|utc|zulu/),
    };
  }

  // "2.5", "2:30", or aviation-style "2+30" -> decimal hours; null if unusable.
  function parseDuration(s) {
    if (s == null) return null;
    s = String(s).trim();
    let m;
    if ((m = s.match(/^(\d{1,3})[:+](\d{1,2})(?::\d{1,2})?$/))) {
      const h = +m[1] + +m[2] / 60;
      return h > 0 ? h : null;
    }
    if ((m = s.match(/^(\d{1,3}(?:\.\d+)?)$/))) {
      const h = +m[1];
      return h > 0 ? h : null;
    }
    return null;
  }

  // ---------- normalization ----------

  function parseDateLoose(s) {
    if (!s) return null;
    s = String(s).trim();
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    let m;
    if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
    if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) {
      let y = +m[3]; if (y < 100) y += 2000;
      return iso(y, +m[1], +m[2]);
    }
    if ((m = s.match(/(\d{1,2})[- ]([a-z]{3})[a-z]*[-, ]+(\d{2,4})/i))) {
      let y = +m[3]; if (y < 100) y += 2000;
      const mo = MONTHS[m[2].toLowerCase()];
      if (mo) return iso(y, mo, +m[1]);
    }
    if ((m = s.match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i))) {
      const mo = MONTHS[m[1].toLowerCase()];
      if (mo) return iso(+m[3], mo, +m[2]);
    }
    return null;

    function iso(y, mo, d) {
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    }
  }

  function normTail(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function tailsEqual(a, b) {
    a = normTail(a); b = normTail(b);
    return a !== "" && a === b;
  }

  function normAirport(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // KAUS and AUS are the same field; FBOs and schedulers disagree on which
  // form to use.
  function airportsEqual(a, b) {
    a = normAirport(a); b = normAirport(b);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length === 4 && a[0] === "K" && a.slice(1) === b) return true;
    if (b.length === 4 && b[0] === "K" && b.slice(1) === a) return true;
    return false;
  }

  function dateDiffDays(a, b) {
    const ta = Date.parse(a + "T00:00:00Z");
    const tb = Date.parse(b + "T00:00:00Z");
    if (isNaN(ta) || isNaN(tb)) return Infinity;
    return Math.abs(Math.round((ta - tb) / 86400000));
  }

  // ---------- invoice text -> fields ----------

  function parseAmount(s) {
    return parseFloat(String(s).replace(/,/g, ""));
  }

  // Best-effort extraction from the text of a World Fuel (or any FBO) invoice.
  // knownTails / knownAirports come from settings and the loaded flight log,
  // and take priority over generic pattern matches.
  function extractInvoiceFields(text, opts) {
    opts = opts || {};
    const out = { tail: "", date: null, airport: "", gallons: null, total: null, invoiceNumber: "" };
    if (!text) return out;
    const upper = text.toUpperCase();
    const squashed = upper.replace(/[^A-Z0-9]/g, "");

    for (const t of opts.knownTails || []) {
      const n = normTail(t);
      if (n && squashed.includes(n)) { out.tail = n; break; }
    }
    if (!out.tail) {
      const m = upper.match(/\bN\d{1,5}[A-Z]{0,2}\b/);
      if (m) out.tail = m[0];
    }

    // World Fuel labels the fueling date "DATE UPLIFTED", and its table layout
    // puts the value several lines after the label once the PDF is flattened
    // to text — so search a window after each label instead of the same line.
    const dateLabels = /date\s+uplifted|uplift(?:ed)?\s+date|delivery date|transaction date|service date|fueling date|date of (?:service|delivery)|flight date/gi;
    let m;
    while ((m = dateLabels.exec(text))) {
      const d = parseDateLoose(text.slice(m.index + m[0].length, m.index + m[0].length + 300));
      if (d) { out.date = d; break; }
    }
    // No usable label: take the EARLIEST date in the document. On an invoice
    // the uplift precedes the invoice date, which precedes the due date.
    if (!out.date) out.date = earliestDate(text);

    // Airport, most to least reliable: an airport the flight log knows,
    // anywhere in the text; a K-prefixed code in a window after a
    // location-ish label; a bare code right after that label; any KXXX.
    for (const ap of opts.knownAirports || []) {
      const n = normAirport(ap);
      if (!n) continue;
      const re = new RegExp("\\b(?:" + n + (n.length === 3 ? "|K" + n : n[0] === "K" ? "|" + n.slice(1) : "") + ")\\b");
      if (re.test(upper)) { out.airport = n; break; }
    }
    const locLabels = /location|airport|delivered (?:at|to)|station|icao|into[- ]plane/gi;
    while (!out.airport && (m = locLabels.exec(text))) {
      const win = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const k = win.match(/\bK[A-Z]{3}\b/);
      if (k) { out.airport = k[0]; break; }
      const near = win.match(/^[:\s]*"?([A-Z]{3,4})\b/);
      if (near && !AIRPORT_STOPWORDS.has(near[1])) { out.airport = near[1]; break; }
    }
    if (!out.airport) {
      m = upper.match(/\bK[A-Z]{3}\b/);
      if (m) out.airport = m[0];
    }

    m = text.match(/([\d,]+(?:\.\d+)?)\s*(?:US\s*)?(?:GAL(?:LON)?S?|USG)\b/i) ||
        text.match(/(?:quantity|qty|volume)[:\s]*([\d,]+(?:\.\d+)?)/i);
    if (m) out.gallons = parseAmount(m[1]);

    // Amounts near a payable-ish label, largest wins so line-item subtotals
    // (fuel, fees, taxes) don't beat the invoice total. World Fuel prints no
    // dollar signs ("USD 660.47") and says "PLEASE REMIT THIS AMOUNT", so
    // accept bare amounts and search a window past each label.
    const amountRe = /(?<![\d.])\$?\s*(\d{1,3}(?:,\d{3})*\.\d{2})(?!\d)/g;
    const totalLabels = /total|remit this amount|invoice amount|amount due|balance due/gi;
    let best = null;
    while ((m = totalLabels.exec(text))) {
      const win = text.slice(m.index, m.index + 120);
      for (const am of win.matchAll(amountRe)) {
        const v = parseAmount(am[1]);
        if (best === null || v > best) best = v;
      }
    }
    if (best === null) {
      for (const am of text.matchAll(amountRe)) {
        const v = parseAmount(am[1]);
        if (best === null || v > best) best = v;
      }
    }
    out.total = best;

    // World Fuel invoice numbers look like 28280400-21101 and sit a few cells
    // after the "INVOICE NO." header (past the customer number, which has no
    // dash) — prefer the dashed form in a window, then same-line adjacency.
    m = text.match(/invoice\s*(?:no\.?|number|num|#)[\s\S]{0,120}?(\d{4,}-\d{2,})/i);
    if (m) out.invoiceNumber = m[1];
    else {
      m = text.match(/invoice\s*(?:no\.?|number|num|#)?[:\s]+([A-Z0-9][A-Z0-9-]{3,})/i);
      if (m && !/^(date|total|invoice|page)/i.test(m[1])) out.invoiceNumber = m[1];
    }

    return out;
  }

  const AIRPORT_STOPWORDS = new Set(["USD", "USG", "GAL", "LLC", "INC", "FBO", "NET", "DUE", "TAX", "QTY", "THE", "AND", "FOR", "PAGE", "ACH", "ABA", "USA"]);

  function earliestDate(text) {
    const patterns = [
      /\d{4}-\d{1,2}-\d{1,2}/g,
      /\d{1,2}\/\d{1,2}\/\d{2,4}/g,
      /\d{1,2}[- ][A-Za-z]{3}[A-Za-z]*[-, ]+\d{2,4}/g,
      /[A-Za-z]{3}[a-z]*\.?\s+\d{1,2},?\s+\d{4}/g,
    ];
    let min = null;
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const d = parseDateLoose(m[0]);
        if (d && (min === null || d < min)) min = d;
      }
    }
    return min;
  }

  // ---------- matching ----------

  // Match one fuel entry {date, tail, airport} against legs
  // [{date, tail, from, to}]. Fuel is normally pumped before departure, so a
  // hit on the leg's departure airport scores above its arrival; a one-day
  // date slip is tolerated (late-night arrivals get invoiced the next
  // morning).
  function matchFuelToLegs(entry, legs) {
    const candidates = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (!tailsEqual(entry.tail, leg.tail)) continue;
      if (!entry.date || !leg.date) continue;
      const dd = dateDiffDays(entry.date, leg.date);
      if (dd > 2) continue;
      let score = 3 - dd;
      if (entry.airport) {
        if (airportsEqual(entry.airport, leg.from)) score += 2;
        else if (airportsEqual(entry.airport, leg.to)) score += 1;
        else score -= 1;
      }
      candidates.push({ index: i, score: score, dateDiff: dd });
    }
    candidates.sort((a, b) => b.score - a.score || a.dateDiff - b.dateDiff);

    if (!candidates.length) return { index: -1, score: 0, status: "unmatched", candidates: [] };
    const top = candidates[0];
    const ambiguous = candidates.length > 1 && candidates[1].score === top.score;
    let status;
    if (ambiguous) status = "review";
    else if (top.score >= 4) status = "auto";
    else if (top.score === 3 && candidates.length === 1) status = "auto";
    else status = "review";
    return { index: top.index, score: top.score, status: status, candidates: candidates };
  }

  // ---------- statement ----------

  // entries: fuel entries with .matchIndex (leg index or -1) and optional
  // .familyOverride. legs carry .family. month: "YYYY-MM" or null for all.
  function buildStatement(entries, legs, month) {
    const families = {};
    const lines = [];
    for (const e of entries) {
      if (month && (!e.date || e.date.slice(0, 7) !== month)) continue;
      const leg = e.matchIndex >= 0 ? legs[e.matchIndex] : null;
      const family = e.familyOverride || (leg && leg.family) || "Unassigned";
      const line = {
        date: e.date || "",
        tail: normTail(e.tail),
        airport: e.airport || "",
        gallons: e.gallons || 0,
        total: e.total || 0,
        invoiceNumber: e.invoiceNumber || "",
        family: family,
        leg: leg ? (leg.from + "-" + leg.to + " " + leg.date) : "(no matched leg)",
      };
      lines.push(line);
      if (!families[family]) families[family] = { total: 0, gallons: 0, count: 0, byTail: {} };
      const f = families[family];
      f.total += line.total;
      f.gallons += line.gallons;
      f.count += 1;
      if (!f.byTail[line.tail]) f.byTail[line.tail] = { total: 0, gallons: 0, count: 0 };
      f.byTail[line.tail].total += line.total;
      f.byTail[line.tail].gallons += line.gallons;
      f.byTail[line.tail].count += 1;
    }
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { families: families, lines: lines };
  }

  function statementCSV(statement) {
    const esc = (v) => {
      v = String(v == null ? "" : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const rows = [["Date", "Family", "Tail", "Airport", "Gallons", "Total", "Invoice #", "Matched leg"]];
    for (const l of statement.lines) {
      rows.push([l.date, l.family, l.tail, l.airport, l.gallons, l.total.toFixed(2), l.invoiceNumber, l.leg]);
    }
    rows.push([]);
    rows.push(["Family", "Uplifts", "Gallons", "Total"]);
    for (const name of Object.keys(statement.families).sort()) {
      const f = statement.families[name];
      rows.push([name, f.count, f.gallons, f.total.toFixed(2)]);
    }
    return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
  }

  // ---------- missing-bill checks ----------

  // Compare each aircraft-month's flying against its invoices and flag the
  // gaps a lost invoice would leave. gphByTail maps normalized tail ->
  // gallons/hour; without it (or without a flight-time column) the
  // hours-vs-gallons comparison is skipped but the structural flags still run.
  // month: "YYYY-MM" to check one month, null for all.
  function monthlyChecks(legs, entries, gphByTail, month) {
    gphByTail = gphByTail || {};
    const buckets = {};
    function bucket(tail, m) {
      const key = tail + "|" + m;
      if (!buckets[key]) buckets[key] = { tail: tail, month: m, flights: 0, hours: 0, hasHours: false, billed: 0, gallons: 0 };
      return buckets[key];
    }
    for (const leg of legs) {
      if (!leg.date || !leg.tail) continue;
      const m = leg.date.slice(0, 7);
      if (month && m !== month) continue;
      const b = bucket(normTail(leg.tail), m);
      b.flights++;
      if (typeof leg.hours === "number" && leg.hours > 0) { b.hours += leg.hours; b.hasHours = true; }
    }
    for (const e of entries) {
      if (!e.date || !e.tail) continue;
      const m = e.date.slice(0, 7);
      if (month && m !== month) continue;
      const b = bucket(normTail(e.tail), m);
      b.billed++;
      b.gallons += e.gallons || 0;
    }
    const out = [];
    for (const key of Object.keys(buckets).sort()) {
      const b = buckets[key];
      const gph = gphByTail[b.tail];
      if (b.flights > 0 && b.billed === 0) {
        out.push({ ...b, level: "warn", message: b.tail + " " + b.month + ": " + b.flights + " flight" + (b.flights > 1 ? "s" : "") + " but no fuel bills — possible missing invoice" });
        continue;
      }
      if (b.flights === 0 && b.billed > 0) {
        out.push({ ...b, level: "warn", message: b.tail + " " + b.month + ": " + b.billed + " fuel bill" + (b.billed > 1 ? "s" : "") + " but no flights in the log — check the bill's date/tail or the log export" });
        continue;
      }
      if (gph > 0 && b.hasHours) {
        const expected = b.hours * gph;
        // Tankering and price-shopping make fuel lumpy month to month, so
        // only a substantial shortfall (>30%) is worth an alarm.
        if (b.gallons < expected * 0.7) {
          out.push({ ...b, expected: expected, level: "warn", message: b.tail + " " + b.month + ": " + b.hours.toFixed(1) + " hrs flown ≈ " + Math.round(expected) + " gal expected at " + gph + " gal/hr, but only " + Math.round(b.gallons) + " gal invoiced — possible missing fuel bill" });
          continue;
        }
        out.push({ ...b, expected: expected, level: "ok", message: b.tail + " " + b.month + ": " + b.flights + " flights, " + b.billed + " fuel bills, " + Math.round(b.gallons) + " gal invoiced vs ≈" + Math.round(expected) + " gal expected — looks complete" });
        continue;
      }
      out.push({ ...b, level: "ok", message: b.tail + " " + b.month + ": " + b.flights + " flights, " + b.billed + " fuel bills, " + Math.round(b.gallons) + " gal invoiced" });
    }
    return out;
  }

  // ---------- yearly miles ----------

  // Airport coordinates generated from OurAirports public-domain data
  // (https://ourairports.com/data/), generated 2026-08-20. All large
  // airports worldwide; medium airports in North/Central America and the
  // Caribbean; US small airports with scheduled service or an IATA code.
  const AIRPORT_COORDS = {
    "05AK": [61.67, -149.19], "05U": [39.60, -116.00], "06U": [41.98, -114.66], "07FA": [25.33, -80.27], "0AK": [61.96, -162.94], "0CO2": [38.85, -106.93],
    "0NM0": [31.82, -107.63], "0S9": [48.05, -122.81], "0TE7": [30.25, -98.62], "19AK": [59.97, -141.66], "1KC": [64.42, -156.82], "1O2": [38.99, -122.90],
    "2AK": [61.36, -155.44], "2AK6": [66.18, -155.68], "2K5": [63.39, -153.27], "2TE0": [28.98, -95.58], "2U7": [44.21, -114.93], "2WA3": [48.68, -123.22],
    "38WA": [48.58, -122.82], "39N": [40.40, -74.66], "3AK5": [60.59, -152.16], "3IS8": [41.23, -89.62], "3NY8": [40.92, -72.79], "3O9": [36.58, -94.86],
    "3T4": [63.12, -142.52], "3TR": [41.84, -86.23], "3VS": [38.43, -92.88], "3W7": [47.92, -119.08], "40G": [35.65, -112.15], "41U": [39.33, -111.61],
    "44U": [39.03, -111.84], "47N": [40.52, -74.60], "4A2": [60.87, -162.27], "4AK": [65.47, -148.65], "4K0": [59.80, -154.13], "4K5": [57.94, -152.46],
    "4R7": [30.47, -92.42], "51Z": [65.15, -149.37], "5A8": [59.28, -158.62], "5MS1": [32.95, -90.85], "5NK": [58.74, -157.02], "65LA": [29.87, -90.02],
    "6Y8": [45.72, -85.52], "78WA": [48.49, -122.83], "7NC2": [36.25, -75.79], "7WA5": [48.67, -123.18], "80F": [34.19, -95.65], "82CL": [39.47, -123.80],
    "89D": [41.60, -82.69], "89NY": [44.31, -75.90], "8XS8": [33.59, -102.04], "90WA": [48.71, -123.02], "9A8": [57.52, -157.40], "9Z8": [59.13, -156.86],
    A61: [60.35, -162.65], A63: [59.07, -160.27], A79: [56.26, -158.77], AGGH: [-9.43, 160.05], AK13: [65.05, -146.05], AK26: [64.56, -164.45],
    AK33: [55.80, -160.90], AK49: [65.68, -164.80], AK75: [65.91, -161.93], AK97: [60.42, -146.15], AQY: [60.97, -149.12], AYNZ: [-6.57, 146.73],
    AYPY: [-9.44, 147.22], BGGH: [64.19, -51.68], BIAR: [65.66, -18.07], BIKF: [63.99, -22.61], BKPR: [42.57, 21.04], BYA: [64.08, -141.12],
    CA92: [39.71, -121.62], CAJ4: [52.45, -125.30], CAT4: [49.34, -124.39], CAZ5: [50.78, -121.32], CBBC: [52.19, -128.16], CHP: [65.49, -144.61],
    CKR: [48.60, -123.00], CKU: [60.54, -145.73], CKX: [64.07, -141.95], CNC3: [43.76, -79.88], CXC: [61.58, -144.43], CYAG: [48.66, -93.44],
    CYAH: [53.75, -73.68], CYAM: [46.48, -84.51], CYAQ: [53.52, -88.64], CYAV: [50.06, -97.03], CYAX: [50.29, -96.01], CYAY: [51.39, -56.08],
    CYAZ: [49.08, -125.78], CYBC: [49.13, -68.20], CYBD: [52.39, -126.60], CYBF: [54.30, -110.74], CYBG: [48.33, -70.99], CYBK: [64.30, -96.08],
    CYBL: [49.95, -125.27], CYBR: [49.91, -99.95], CYBU: [53.33, -104.01], CYBW: [51.10, -114.37], CYBX: [51.44, -57.19], CYCB: [69.11, -105.14],
    CYCC: [45.09, -74.57], CYCD: [49.05, -123.87], CYCE: [43.29, -81.51], CYCG: [49.30, -117.63], CYCH: [47.01, -65.45], CYCL: [47.99, -66.33],
    CYCN: [49.11, -81.01], CYCP: [52.12, -119.28], CYCQ: [55.69, -121.63], CYDA: [64.04, -139.13], CYDB: [61.37, -139.04], CYDF: [49.21, -57.40],
    CYDM: [61.97, -132.42], CYDN: [51.10, -100.05], CYDO: [48.78, -72.38], CYDQ: [55.74, -120.18], CYEE: [44.68, -79.93], CYEG: [53.31, -113.58],
    CYEL: [46.35, -82.56], CYEM: [45.84, -81.86], CYEN: [49.21, -102.97], CYET: [53.58, -116.46], CYEV: [68.30, -133.48], CYEY: [48.56, -78.25],
    CYFB: [63.76, -68.56], CYFC: [45.87, -66.53], CYFD: [43.13, -80.34], CYFE: [48.75, -69.10], CYFJ: [46.41, -74.78], CYFR: [61.18, -113.69],
    CYFS: [61.76, -121.24], CYGD: [43.77, -81.71], CYGE: [51.30, -116.98], CYGK: [44.23, -76.60], CYGL: [53.63, -77.70], CYGM: [50.63, -97.04],
    CYGP: [48.77, -64.48], CYGQ: [49.78, -86.94], CYGR: [47.43, -61.78], CYGV: [50.28, -63.61], CYGW: [55.28, -77.77], CYHD: [49.83, -92.74],
    CYHF: [49.71, -83.69], CYHM: [43.17, -79.93], CYHN: [49.19, -84.76], CYHT: [60.79, -137.55], CYHU: [45.52, -73.42], CYHY: [60.84, -115.78],
    CYHZ: [44.88, -63.51], CYIB: [48.77, -91.64], CYID: [44.55, -65.79], CYIF: [51.21, -58.66], CYIV: [53.86, -94.65], CYJF: [60.24, -123.47],
    CYJN: [45.29, -73.28], CYJT: [48.54, -58.55], CYKA: [50.70, -120.45], CYKF: [43.46, -80.38], CYKJ: [57.26, -105.62], CYKL: [54.81, -66.81],
    CYKM: [44.20, -81.61], CYKX: [48.21, -79.98], CYKY: [51.52, -109.18], CYLD: [47.82, -83.35], CYLJ: [54.13, -108.52], CYLL: [53.31, -110.07],
    CYLR: [56.51, -99.99], CYLS: [44.49, -79.55], CYLT: [82.52, -62.28], CYLW: [49.96, -119.38], CYMA: [63.62, -135.87], CYME: [48.86, -67.45],
    CYMG: [49.08, -85.86], CYMJ: [50.33, -105.56], CYML: [47.60, -70.22], CYMM: [56.65, -111.22], CYMO: [51.29, -80.61], CYMT: [49.77, -74.53],
    CYMX: [45.68, -74.04], CYNA: [50.19, -61.79], CYND: [45.52, -75.56], CYNJ: [49.10, -122.63], CYNL: [58.28, -104.08], CYNM: [49.76, -77.80],
    CYNN: [59.49, -97.78], CYOA: [64.70, -110.61], CYOD: [54.40, -110.28], CYOJ: [58.62, -117.17], CYOO: [43.92, -78.89], CYOP: [58.49, -119.41],
    CYOS: [44.59, -80.84], CYOW: [45.32, -75.67], CYPA: [53.21, -105.67], CYPD: [45.66, -61.37], CYPE: [56.23, -117.45], CYPG: [49.90, -98.27],
    CYPK: [49.21, -122.71], CYPL: [51.45, -90.21], CYPN: [49.84, -64.29], CYPQ: [44.23, -78.36], CYPR: [54.29, -130.45], CYPW: [49.83, -124.50],
    CYPX: [60.05, -77.29], CYPY: [58.77, -111.12], CYPZ: [54.38, -125.95], CYQA: [44.98, -79.31], CYQB: [46.79, -71.39], CYQD: [53.97, -101.09],
    CYQF: [52.18, -113.89], CYQG: [42.28, -82.96], CYQH: [60.12, -128.82], CYQI: [43.83, -66.09], CYQK: [49.79, -94.36], CYQL: [49.63, -112.80],
    CYQM: [46.11, -64.68], CYQN: [50.18, -86.70], CYQQ: [49.71, -124.89], CYQR: [50.43, -104.66], CYQS: [42.77, -81.11], CYQT: [48.37, -89.32],
    CYQU: [55.18, -118.89], CYQV: [51.26, -102.46], CYQW: [52.77, -108.24], CYQX: [48.94, -54.57], CYQY: [46.16, -60.05], CYQZ: [53.03, -122.51],
    CYRB: [74.72, -94.97], CYRI: [47.76, -69.58], CYRJ: [48.52, -72.27], CYRL: [51.07, -93.79], CYRO: [45.46, -75.64], CYRP: [45.32, -76.02],
    CYRQ: [46.35, -72.68], CYRT: [62.81, -92.12], CYRV: [50.96, -118.18], CYSB: [46.63, -80.80], CYSC: [45.44, -71.69], CYSF: [59.25, -105.84],
    CYSG: [46.10, -70.71], CYSH: [44.95, -75.94], CYSJ: [45.32, -65.89], CYSL: [47.16, -67.84], CYSM: [60.02, -111.96], CYSN: [43.19, -79.17],
    CYSP: [48.76, -86.34], CYSU: [46.44, -63.83], CYTA: [45.86, -77.25], CYTF: [48.51, -71.64], CYTH: [55.80, -97.86], CYTR: [44.12, -77.53],
    CYTS: [48.57, -81.38], CYTZ: [43.63, -79.40], CYUL: [45.47, -73.74], CYUX: [68.78, -81.24], CYUY: [48.21, -78.84], CYVB: [48.07, -65.46],
    CYVC: [55.15, -105.26], CYVD: [49.88, -100.92], CYVK: [50.25, -119.33], CYVO: [48.05, -77.78], CYVP: [58.10, -68.43], CYVQ: [65.28, -126.80],
    CYVR: [49.19, -123.18], CYVV: [44.75, -81.11], CYWG: [49.91, -97.24], CYWK: [52.92, -66.86], CYWL: [52.18, -122.05], CYWY: [63.21, -123.44],
    CYXC: [49.61, -115.78], CYXE: [52.17, -106.70], CYXH: [50.02, -110.72], CYXJ: [56.24, -120.74], CYXK: [48.48, -68.50], CYXL: [50.11, -91.91],
    CYXQ: [62.41, -140.87], CYXR: [47.70, -79.85], CYXS: [53.88, -122.67], CYXT: [54.47, -128.58], CYXU: [43.03, -81.15], CYXX: [49.03, -122.36],
    CYXY: [60.71, -135.07], CYXZ: [47.97, -84.79], CYYB: [46.36, -79.42], CYYC: [51.12, -114.01], CYYD: [54.82, -127.18], CYYE: [58.84, -122.60],
    CYYF: [49.46, -119.60], CYYG: [46.29, -63.13], CYYJ: [48.65, -123.43], CYYL: [56.86, -101.08], CYYN: [50.29, -107.69], CYYQ: [58.74, -94.07],
    CYYR: [53.32, -60.43], CYYT: [47.62, -52.75], CYYU: [49.41, -82.47], CYYW: [50.29, -88.91], CYYY: [48.61, -68.21], CYYZ: [43.68, -79.63],
    CYZE: [45.89, -82.57], CYZF: [62.46, -114.44], CYZH: [55.29, -114.78], CYZP: [53.25, -131.81], CYZR: [43.00, -82.31], CYZS: [64.19, -83.36],
    CYZT: [50.68, -127.37], CYZU: [54.14, -115.79], CYZV: [50.22, -66.27], CYZW: [60.17, -132.74], CYZX: [44.98, -64.92], CYZY: [55.30, -123.13],
    CZAM: [50.68, -119.23], CZBB: [49.07, -123.01], CZBF: [47.63, -65.74], CZBM: [45.29, -72.74], CZEE: [56.04, -96.51], CZFA: [62.21, -133.38],
    CZGF: [49.02, -118.43], CZJG: [54.52, -98.05], CZJN: [52.12, -101.24], CZLQ: [55.32, -97.71], CZMN: [55.59, -97.16], CZMT: [54.03, -132.13],
    CZN: [62.07, -142.05], CZO: [62.56, -144.67], CZPC: [49.52, -114.00], CZSJ: [53.06, -93.34], CZST: [55.94, -129.98], CZUC: [49.43, -91.72],
    D60: [48.38, -102.90], D66: [64.05, -145.72], DAAE: [36.71, 5.07], DAAG: [36.69, 3.21], DAAJ: [24.29, 9.46], DAAT: [22.81, 5.45],
    DAAV: [36.79, 5.87], DABB: [36.83, 7.81], DABC: [36.28, 6.62], DABT: [35.75, 6.31], DAOI: [36.22, 1.34], DAON: [35.01, -1.46],
    DAOO: [35.62, -0.62], DAUB: [34.79, 5.74], DBBB: [6.36, 2.38], DFFD: [12.35, -1.51], DFOO: [11.16, -4.33], DGAA: [5.61, -0.17],
    DGLE: [9.55, -0.87], DGSI: [6.71, -1.59], DIAP: [5.26, -3.93], DIYO: [6.90, -5.37], DNAA: [9.01, 7.26], DNAS: [6.20, 6.67],
    DNBC: [10.48, 9.74], DNBK: [12.48, 4.37], DNEN: [6.47, 7.56], DNIL: [8.44, 4.49], DNKA: [10.70, 7.32], DNKN: [12.05, 8.52],
    DNMA: [11.85, 13.08], DNMM: [6.58, 3.32], DNPO: [5.02, 6.95], DNSO: [12.92, 5.21], DRRN: [13.48, 2.18], DTTA: [36.85, 10.23],
    DTTJ: [33.87, 10.78], DXNG: [9.77, 1.09], DXXX: [6.17, 1.25], E01: [31.58, -102.91], E13: [31.42, -102.36], E14: [36.03, -106.05],
    EBBR: [50.90, 4.48], EBCI: [50.46, 4.46], EBOS: [51.20, 2.87], EDDB: [52.36, 13.50], EDDC: [51.13, 13.77], EDDE: [50.98, 10.96],
    EDDF: [50.03, 8.56], EDDG: [52.13, 7.69], EDDH: [53.63, 9.99], EDDK: [50.87, 7.14], EDDL: [51.29, 6.77], EDDM: [48.35, 11.79],
    EDDN: [49.50, 11.08], EDDP: [51.42, 12.23], EDDS: [48.69, 9.22], EDDV: [52.46, 9.69], EDDW: [53.05, 8.79], EDFH: [49.95, 7.26],
    EDJA: [47.99, 10.24], EDLP: [51.61, 8.62], EDLV: [51.60, 6.14], EDLW: [51.52, 7.61], EDNY: [47.67, 9.51], EDSB: [48.78, 8.08],
    EDVK: [51.42, 9.39], EETN: [59.41, 24.83], EFHK: [60.32, 24.96], EFIV: [68.61, 27.41], EFKT: [67.70, 24.85], EFKU: [63.01, 27.80],
    EFLP: [61.04, 28.14], EFOU: [64.93, 25.35], EFRO: [66.56, 25.83], EFTP: [61.41, 23.60], EFTU: [60.51, 22.26], EFVA: [63.05, 21.76],
    EGAA: [54.66, -6.22], EGBB: [52.45, -1.75], EGCC: [53.35, -2.28], EGFF: [51.40, -3.34], EGGD: [51.38, -2.72], EGGP: [53.33, -2.85],
    EGGW: [51.87, -0.37], EGKK: [51.15, -0.19], EGLL: [51.47, -0.46], EGNM: [53.87, -1.66], EGNS: [54.08, -4.62], EGNT: [55.04, -1.69],
    EGNX: [52.83, -1.33], EGPD: [57.20, -2.20], EGPF: [55.87, -4.43], EGPH: [55.95, -3.37], EGPK: [55.50, -4.58], EGSS: [51.88, 0.23],
    EGYP: [-51.82, -58.45], EHAM: [52.31, 4.76], EHBK: [50.91, 5.77], EHEH: [51.45, 5.37], EHGG: [53.12, 6.58], EHRD: [51.96, 4.44],
    EICK: [51.84, -8.49], EIDW: [53.43, -6.26], EIKN: [53.91, -8.82], EINN: [52.70, -8.92], EKAH: [56.30, 10.62], EKBI: [55.74, 9.16],
    EKCH: [55.62, 12.66], EKOD: [55.48, 10.33], EKVG: [62.06, -7.28], EKYT: [57.09, 9.85], ELLX: [49.63, 6.21], ENAL: [62.56, 6.11],
    ENBO: [67.27, 14.37], ENBR: [60.29, 5.22], ENCN: [58.20, 8.09], ENEV: [68.49, 16.68], ENGM: [60.19, 11.10], ENTC: [69.68, 18.92],
    ENTO: [59.19, 10.26], ENVA: [63.46, 10.92], ENZV: [58.88, 5.64], EPGD: [54.38, 18.47], EPKK: [50.08, 19.78], EPKT: [50.48, 19.08],
    EPLB: [51.24, 22.71], EPLL: [51.72, 19.40], EPMO: [52.45, 20.65], EPPO: [52.42, 16.82], EPRZ: [50.11, 22.02], EPSC: [53.58, 14.90],
    EPWA: [52.17, 20.97], EPWR: [51.10, 16.88], ESGG: [57.66, 12.28], ESKN: [58.79, 16.91], ESKS: [61.17, 12.83], ESMS: [55.54, 13.38],
    ESNQ: [67.82, 20.34], ESNU: [63.79, 20.28], ESOW: [59.59, 16.63], ESPA: [65.54, 22.12], ESSA: [59.65, 17.93], ESSL: [58.40, 15.68],
    ESSV: [57.66, 18.35], EVLA: [56.52, 21.10], EVRA: [56.92, 23.97], EYKA: [54.96, 24.09], EYPA: [55.97, 21.09], EYVI: [54.63, 25.29],
    F05: [34.23, -99.28], F23: [32.45, -98.68], FABL: [-29.09, 26.30], FACT: [-33.97, 18.60], FAEL: [-33.04, 27.83], FAGG: [-34.01, 22.38],
    FAKM: [-28.81, 24.76], FAKN: [-25.38, 31.11], FALA: [-25.94, 27.93], FALE: [-29.61, 31.12], FAOR: [-26.14, 28.25], FAPE: [-33.99, 25.62],
    FAPP: [-23.85, 29.46], FBKE: [-17.83, 25.17], FBMN: [-19.97, 23.43], FBPM: [-21.16, 27.47], FBSK: [-24.56, 25.92], FCBB: [-4.25, 15.25],
    FCPP: [-4.82, 11.89], FDSK: [-26.36, 31.72], FEFF: [4.40, 18.52], FGBT: [1.91, 9.81], FGCO: [0.91, 9.33], FGSL: [3.76, 8.71],
    FIMP: [-20.43, 57.68], FKKD: [4.01, 9.72], FKKR: [9.33, 13.37], FKYS: [3.72, 11.55], FLHN: [-17.82, 25.82], FLKK: [-15.33, 28.45],
    FLMF: [-13.26, 31.94], FLSK: [-12.97, 28.52], FLT: [62.45, -157.99], FMCH: [-11.53, 43.27], FMCZ: [-12.81, 45.28], FMEE: [-20.89, 55.52],
    FMEP: [-21.32, 55.42], FMMI: [-18.80, 47.48], FMMT: [-18.11, 49.39], FMNM: [-15.67, 46.35], FMNN: [-13.31, 48.31], FNBJ: [-9.05, 13.50],
    FNLU: [-8.86, 13.23], FOOG: [-0.71, 8.75], FOOL: [0.46, 9.41], FPST: [0.38, 6.71], FQBR: [-19.80, 34.91], FQMA: [-25.92, 32.57],
    FQNP: [-15.11, 39.28], FQTT: [-16.10, 33.64], FSIA: [-4.67, 55.52], FTTJ: [12.13, 15.03], FVFA: [-18.10, 25.84], FVJN: [-20.02, 28.62],
    FVRG: [-17.93, 31.09], FWCL: [-15.68, 34.97], FWKI: [-13.79, 33.78], FXMM: [-29.46, 27.55], FYWB: [-22.98, 14.65], FYWH: [-22.48, 17.47],
    FZAA: [-4.39, 15.44], FZIC: [0.48, 25.34], FZNA: [-1.67, 29.24], FZQA: [-11.59, 27.53], GABS: [12.53, -7.95], GATB: [16.73, -3.01],
    GBYD: [13.34, -16.65], GCFV: [28.45, -13.86], GCLP: [27.93, -15.39], GCRR: [28.95, -13.61], GCTS: [28.04, -16.57], GCXO: [28.48, -16.34],
    GFLL: [8.62, -13.20], GGOV: [11.89, -15.65], GLRB: [6.23, -10.36], GMAD: [30.32, -9.41], GMAZ: [30.27, -5.86], GMFF: [33.93, -4.98],
    GMFO: [34.79, -1.93], GMMD: [32.40, -6.32], GMME: [34.05, -6.75], GMMH: [23.72, -15.93], GMML: [27.14, -13.22], GMMN: [33.37, -7.59],
    GMMW: [34.99, -3.03], GMMX: [31.60, -8.04], GMMZ: [30.94, -6.91], GMTN: [35.59, -5.32], GMTT: [35.73, -5.92], GNU: [59.12, -161.58],
    GOBD: [14.67, -17.07], GOOY: [14.74, -17.48], GQNO: [18.31, -15.97], GQPP: [20.93, -17.03], GUCY: [9.58, -13.61], GVAC: [16.74, -22.95],
    GVBA: [16.14, -22.89], GVNP: [14.94, -23.48], GVSV: [16.83, -25.06], HAAB: [8.98, 38.80], HADR: [9.62, 41.86], HAJJ: [9.33, 42.91],
    HALA: [7.10, 38.40], HBBA: [-3.32, 29.32], HCMF: [11.28, 49.14], HCMH: [9.51, 44.08], HCMM: [2.01, 45.30], HDAM: [11.55, 43.16],
    HEAL: [30.92, 28.46], HEAR: [31.06, 33.83], HEAT: [27.05, 31.01], HEAX: [30.93, 29.70], HEBR: [23.98, 35.46], HECA: [30.11, 31.40],
    HEGN: [27.18, 33.80], HELX: [25.67, 32.71], HEMA: [25.56, 34.59], HEMM: [31.32, 27.22], HEPS: [31.28, 32.24], HESG: [26.34, 31.74],
    HESH: [27.98, 34.39], HESN: [23.96, 32.82], HESX: [30.11, 30.90], HI01: [22.21, -159.45], HJJJ: [4.87, 31.60], HKB: [64.00, -144.69],
    HKEL: [0.40, 35.24], HKJK: [-1.32, 36.93], HKKI: [-0.09, 34.73], HKMO: [-4.03, 39.59], HLGD: [31.06, 16.60], HLLB: [32.10, 20.27],
    HLLM: [32.89, 13.29], HLLQ: [32.79, 21.95], HRYR: [-1.97, 30.14], HSPN: [19.43, 37.23], HSSK: [15.59, 32.55], HTDA: [-6.87, 39.21],
    HTKJ: [-3.43, 37.07], HTMW: [-2.45, 32.94], HTZA: [-6.22, 39.22], HUEN: [0.04, 32.44], JLA: [60.48, -149.72], K00C: [37.20, -107.87],
    K00F: [45.47, -105.46], K07: [37.94, -91.81], K0B8: [41.25, -72.03], K0F3: [43.39, -95.14], K0K7: [42.73, -94.25], K0V7: [36.72, -110.23],
    K15: [38.11, -92.68], K1B1: [42.29, -73.71], K1F0: [34.15, -97.12], K1G4: [35.99, -113.82], K1O5: [41.73, -122.55], K1O6: [41.26, -122.27],
    K1RL: [48.98, -123.08], K1V6: [38.43, -105.11], K1Z1: [36.26, -113.23], K29: [64.90, -163.70], K2B3: [43.39, -72.19], K2F0: [30.91, -101.89],
    K2G4: [39.58, -79.34], K2O1: [39.94, -120.94], K2S7: [42.58, -121.88], K2W6: [38.32, -76.55], K35A: [34.69, -81.64], K37V: [40.34, -99.91],
    K3S8: [42.51, -123.39], K4S1: [42.41, -124.42], K50I: [40.76, -87.43], K5N2: [45.54, -90.28], K5T9: [28.86, -100.52], K67L: [36.83, -114.06],
    K6B6: [42.46, -71.52], K6D9: [44.31, -83.42], K6S2: [43.98, -124.11], K74S: [48.50, -122.66], K74V: [40.28, -110.05], K76F: [32.68, -95.98],
    K79J: [31.31, -86.39], K7G9: [43.31, -96.57], K7V2: [38.83, -107.65], KAAF: [29.73, -85.03], KABE: [40.65, -75.44], KABI: [32.41, -99.68],
    KABQ: [35.04, -106.61], KABR: [45.45, -98.42], KABY: [31.53, -84.20], KACB: [44.99, -85.20], KACK: [41.25, -70.06], KACT: [31.61, -97.23],
    KACV: [40.98, -124.11], KACY: [39.46, -74.58], KADG: [41.87, -84.08], KADH: [34.81, -96.67], KADM: [34.30, -97.02], KADS: [32.97, -96.84],
    KADW: [38.81, -76.87], KAEG: [35.15, -106.79], KAEL: [43.68, -93.37], KAEX: [31.33, -92.55], KAFF: [38.97, -104.82], KAFJ: [40.14, -80.29],
    KAFN: [42.81, -72.00], KAFO: [42.71, -110.94], KAFW: [32.99, -97.32], KAGC: [40.35, -79.93], KAGO: [33.23, -93.22], KAGS: [33.37, -81.96],
    KAHC: [40.27, -120.15], KAHH: [45.28, -92.38], KAHN: [33.95, -83.33], KAIA: [42.05, -102.80], KAID: [40.11, -85.61], KAIK: [33.65, -81.68],
    KAIO: [41.41, -95.05], KAIV: [33.11, -88.20], KAIZ: [38.10, -92.55], KAKO: [40.18, -103.22], KAKR: [41.04, -81.47], KALB: [42.75, -73.80],
    KALI: [27.74, -98.03], KALM: [32.84, -105.99], KALN: [38.89, -90.05], KALO: [42.56, -92.40], KALS: [37.43, -105.87], KALW: [46.09, -118.29],
    KALX: [32.91, -85.96], KAMA: [35.22, -101.71], KAMN: [43.32, -84.69], KAMW: [41.99, -93.62], KANB: [33.59, -85.86], KAND: [34.49, -82.71],
    KANK: [38.54, -106.05], KANP: [38.94, -76.57], KANQ: [41.64, -85.08], KANW: [42.58, -99.99], KANY: [37.16, -98.08], KAOH: [40.71, -84.03],
    KAOO: [40.30, -78.32], KAPA: [39.57, -104.85], KAPC: [38.21, -122.28], KAPF: [26.15, -81.78], KAPG: [39.47, -76.17], KAPH: [38.07, -77.32],
    KAPN: [45.08, -83.56], KAPT: [35.06, -85.59], KAPV: [34.58, -117.19], KARA: [30.04, -91.88], KARB: [42.22, -83.75], KARG: [36.12, -90.93],
    KARM: [29.25, -96.15], KARR: [41.77, -88.48], KART: [43.99, -76.02], KARV: [45.93, -89.73], KARW: [32.41, -80.63], KASE: [39.22, -106.87],
    KASG: [36.18, -94.12], KASH: [42.78, -71.51], KASL: [32.52, -94.31], KASN: [33.57, -86.05], KAST: [46.16, -123.88], KASX: [46.55, -90.92],
    KASY: [46.02, -99.35], KATL: [33.64, -84.43], KATS: [32.85, -104.47], KATW: [44.26, -88.52], KATY: [44.91, -97.15], KAUG: [44.32, -69.80],
    KAUM: [43.67, -92.93], KAUN: [38.95, -121.08], KAUO: [32.62, -85.43], KAUS: [30.20, -97.66], KAUW: [44.93, -89.63], KAVL: [35.44, -82.54],
    KAVO: [27.59, -81.53], KAVP: [41.34, -75.72], KAVQ: [32.41, -111.22], KAVX: [33.40, -118.42], KAWM: [35.14, -90.23], KAWO: [48.16, -122.16],
    KAXA: [43.08, -94.27], KAXN: [45.87, -95.39], KAXS: [34.70, -99.34], KAXV: [40.49, -84.30], KAXX: [36.42, -105.29], KAYS: [31.25, -82.40],
    KAYX: [35.39, -86.09], KAZO: [42.23, -85.55], KBAB: [39.14, -121.44], KBAD: [32.50, -93.66], KBAF: [42.16, -72.72], KBAK: [39.26, -85.90],
    KBAM: [40.60, -116.87], KBAZ: [29.70, -98.04], KBBB: [45.33, -95.65], KBBD: [31.18, -99.32], KBBG: [36.53, -93.20], KBBP: [34.62, -79.73],
    KBBW: [41.44, -99.64], KBCB: [37.21, -80.41], KBCE: [37.71, -112.14], KBCT: [26.38, -80.11], KBDE: [48.73, -94.61], KBDG: [37.58, -109.48],
    KBDH: [45.12, -95.13], KBDL: [41.94, -72.69], KBDR: [41.16, -73.13], KBDU: [40.04, -105.23], KBEC: [37.69, -97.21], KBED: [42.47, -71.29],
    KBEH: [42.13, -86.43], KBFD: [41.80, -78.64], KBFF: [41.87, -103.60], KBFI: [47.53, -122.30], KBFL: [35.43, -119.06], KBFM: [30.63, -88.07],
    KBFR: [38.84, -86.45], KBGD: [35.70, -101.39], KBGE: [30.97, -84.64], KBGM: [42.21, -75.98], KBGR: [44.81, -68.83], KBHB: [44.45, -68.36],
    KBHM: [33.56, -86.75], KBID: [41.17, -71.58], KBIE: [40.30, -96.75], KBIF: [31.85, -106.38], KBIH: [37.37, -118.36], KBIL: [45.81, -108.54],
    KBIS: [46.77, -100.75], KBIX: [30.41, -88.92], KBJC: [39.91, -105.12], KBJI: [47.51, -94.93], KBJJ: [40.87, -81.89], KBKD: [32.72, -98.89],
    KBKE: [44.84, -117.81], KBKF: [39.70, -104.75], KBKL: [41.52, -81.68], KBKN: [36.75, -97.35], KBKT: [37.07, -77.96], KBKW: [37.79, -81.12],
    KBKX: [44.30, -96.82], KBLF: [37.30, -81.21], KBLH: [33.62, -114.72], KBLI: [48.79, -122.54], KBLM: [40.19, -74.12], KBLU: [39.28, -120.71],
    KBLV: [38.55, -89.84], KBMC: [41.55, -112.06], KBMG: [39.15, -86.62], KBMI: [40.48, -88.92], KBML: [44.58, -71.18], KBMT: [30.07, -94.22],
    KBNA: [36.12, -86.68], KBNG: [33.92, -116.85], KBNL: [33.26, -81.39], KBNO: [43.59, -118.96], KBNW: [42.05, -93.85], KBOI: [43.56, -116.22],
    KBOK: [42.07, -124.29], KBOS: [42.36, -71.01], KBOW: [27.94, -81.78], KBPG: [32.21, -101.52], KBPI: [42.59, -110.11], KBPK: [36.37, -92.47],
    KBPT: [29.95, -94.02], KBQK: [31.26, -81.47], KBRD: [46.40, -94.13], KBRL: [40.78, -91.13], KBRO: [25.91, -97.43], KBRY: [37.81, -85.50],
    KBTF: [40.87, -111.93], KBTL: [42.31, -85.25], KBTM: [45.95, -112.50], KBTN: [45.82, -97.74], KBTP: [40.78, -79.95], KBTR: [30.53, -91.15],
    KBTV: [44.47, -73.15], KBTY: [36.86, -116.79], KBUB: [41.78, -99.15], KBUF: [42.94, -78.73], KBUM: [38.29, -94.34], KBUR: [34.20, -118.36],
    KBVI: [40.77, -80.39], KBVO: [36.76, -96.01], KBVS: [48.47, -122.42], KBVU: [35.95, -114.86], KBVX: [35.73, -91.65], KBVY: [42.58, -70.92],
    KBWC: [32.99, -115.52], KBWD: [31.79, -98.96], KBWG: [36.96, -86.42], KBWI: [39.18, -76.67], KBWP: [46.24, -96.61], KBWW: [46.17, -103.30],
    KBXA: [30.81, -89.86], KBXK: [33.42, -112.69], KBXM: [43.89, -69.94], KBYG: [44.38, -106.72], KBYH: [35.96, -89.94], KBYI: [42.54, -113.77],
    KBYS: [35.28, -116.63], KBYY: [28.97, -95.86], KBZN: [45.78, -111.15], KC02: [42.61, -88.39], KC65: [41.37, -86.30], KC80: [36.16, -120.29],
    KCAD: [44.28, -85.42], KCAE: [33.94, -81.12], KCAG: [40.50, -107.52], KCAK: [40.92, -81.44], KCAO: [36.45, -103.17], KCAR: [46.87, -68.02],
    KCBE: [39.62, -78.76], KCBF: [41.26, -95.76], KCBK: [39.43, -101.05], KCBM: [33.64, -88.44], KCCB: [34.11, -117.69], KCCR: [37.99, -122.06],
    KCCY: [43.07, -92.61], KCDA: [44.57, -72.02], KCDC: [37.70, -113.10], KCDH: [33.62, -92.76], KCDK: [29.13, -83.05], KCDN: [34.28, -80.56],
    KCDR: [42.84, -103.10], KCDS: [34.43, -100.29], KCDW: [40.88, -74.28], KCEA: [37.65, -97.25], KCEC: [41.78, -124.24], KCEF: [42.19, -72.53],
    KCEU: [34.67, -82.89], KCEV: [39.70, -85.13], KCEW: [30.78, -86.52], KCEY: [36.66, -88.37], KCEZ: [37.30, -108.63], KCFD: [30.72, -96.33],
    KCFS: [43.46, -83.45], KCFT: [32.96, -109.21], KCFV: [37.09, -95.57], KCGE: [38.54, -76.03], KCGF: [41.57, -81.49], KCGI: [37.23, -89.57],
    KCGS: [38.98, -76.92], KCGZ: [32.95, -111.77], KCHA: [35.04, -85.20], KCHK: [35.10, -97.97], KCHO: [38.14, -78.45], KCHS: [32.90, -80.04],
    KCIC: [39.80, -121.86], KCID: [41.88, -91.71], KCIN: [42.05, -94.79], KCIR: [37.06, -89.22], KCIU: [46.24, -84.46], KCKA: [36.73, -98.12],
    KCKB: [39.30, -80.23], KCKC: [47.84, -90.38], KCKM: [34.30, -90.51], KCKN: [47.84, -96.62], KCKV: [36.62, -87.42], KCL: [56.31, -158.53],
    KCLE: [41.41, -81.85], KCLI: [44.61, -88.73], KCLK: [35.54, -98.93], KCLL: [30.59, -96.36], KCLM: [48.12, -123.50], KCLR: [33.13, -115.52],
    KCLS: [46.68, -122.98], KCLT: [35.21, -80.94], KCLW: [27.98, -82.76], KCMA: [34.21, -119.09], KCMH: [40.00, -82.89], KCMI: [40.04, -88.28],
    KCMX: [47.17, -88.49], KCMY: [43.96, -90.74], KCNH: [43.37, -72.37], KCNK: [39.55, -97.65], KCNM: [32.34, -104.26], KCNO: [33.97, -117.64],
    KCNU: [37.67, -95.49], KCNW: [31.64, -97.07], KCNY: [38.76, -109.75], KCOD: [44.52, -109.02], KCOE: [47.77, -116.82], KCOF: [28.23, -80.61],
    KCOI: [28.34, -80.69], KCOM: [31.84, -99.40], KCON: [43.20, -71.50], KCOS: [38.81, -104.70], KCOT: [28.46, -99.22], KCOU: [38.82, -92.22],
    KCPM: [33.89, -118.24], KCPR: [42.91, -106.46], KCPS: [38.57, -90.16], KCQW: [34.71, -79.96], KCR: [63.57, -156.01], KCRE: [33.81, -78.72],
    KCRG: [30.34, -81.51], KCRP: [27.77, -97.50], KCRQ: [33.13, -117.28], KCRS: [32.03, -96.40], KCRT: [33.18, -91.88], KCRW: [38.37, -81.59],
    KCRX: [34.92, -88.60], KCSG: [32.52, -84.94], KCSM: [35.34, -99.20], KCSQ: [41.02, -94.36], KCSV: [35.95, -85.08], KCTB: [48.61, -112.38],
    KCTY: [29.64, -83.10], KCTZ: [34.98, -78.36], KCUB: [33.97, -81.00], KCUH: [35.95, -96.77], KCVG: [39.05, -84.67], KCVH: [36.89, -121.41],
    KCVK: [36.26, -91.56], KCVN: [34.43, -103.08], KCVO: [44.50, -123.29], KCVS: [34.38, -103.32], KCVX: [45.30, -85.27], KCWA: [44.78, -89.67],
    KCWC: [33.86, -98.49], KCWF: [30.21, -93.14], KCWI: [41.83, -90.33], KCXL: [32.67, -115.51], KCXO: [30.35, -95.41], KCXP: [39.19, -119.73],
    KCXY: [40.22, -76.85], KCYS: [41.16, -104.81], KCZK: [45.68, -121.88], KCZT: [28.52, -99.82], KDAA: [38.72, -77.18], KDAB: [29.18, -81.06],
    KDAG: [34.85, -116.79], KDAL: [32.84, -96.85], KDAN: [36.57, -79.34], KDAY: [39.90, -84.22], KDBN: [32.56, -82.99], KDBQ: [42.40, -90.71],
    KDCA: [38.85, -77.04], KDCU: [34.65, -86.95], KDDC: [37.76, -99.97], KDEC: [39.83, -88.87], KDEH: [43.28, -91.74], KDEN: [39.86, -104.67],
    KDET: [42.41, -83.01], KDFI: [41.34, -84.43], KDFW: [32.90, -97.04], KDGL: [31.34, -109.51], KDGW: [42.80, -105.39], KDHN: [31.32, -85.45],
    KDHT: [36.02, -102.55], KDIK: [46.80, -102.80], KDJT: [26.68, -80.10], KDKK: [42.49, -79.27], KDLC: [34.45, -79.37], KDLF: [29.36, -100.78],
    KDLH: [46.84, -92.20], KDLN: [45.26, -112.55], KDLS: [45.62, -121.17], KDMA: [32.17, -110.88], KDMN: [32.26, -107.72], KDMO: [38.71, -93.18],
    KDNL: [33.47, -82.04], KDNN: [34.72, -84.87], KDNS: [41.99, -95.38], KDNV: [40.20, -87.60], KDOV: [39.13, -75.47], KDPA: [41.91, -88.25],
    KDPG: [40.20, -112.94], KDRA: [36.62, -116.03], KDRI: [30.83, -93.34], KDRM: [46.01, -83.74], KDRO: [37.15, -107.75], KDRT: [29.37, -100.93],
    KDSM: [41.53, -93.66], KDSV: [42.57, -77.71], KDTA: [39.38, -112.51], KDTL: [46.82, -95.88], KDTN: [32.54, -93.75], KDTS: [30.40, -86.47],
    KDTW: [42.21, -83.35], KDUA: [33.94, -96.40], KDUC: [34.47, -97.96], KDUG: [31.46, -109.60], KDUJ: [41.18, -78.90], KDVL: [48.12, -98.91],
    KDVN: [41.61, -90.59], KDVO: [38.14, -122.56], KDVP: [43.99, -95.78], KDVT: [33.69, -112.08], KDWH: [30.06, -95.55], KDXR: [41.37, -73.48],
    KDYL: [40.33, -75.12], KDYS: [32.42, -99.85], KE24: [33.81, -109.99], KE38: [30.38, -103.68], KE51: [34.59, -113.17], KEAN: [42.06, -104.93],
    KEAR: [40.73, -99.01], KEAT: [47.40, -120.21], KEAU: [44.87, -91.48], KEB: [59.35, -151.93], KEBS: [42.44, -93.87], KECG: [36.26, -76.17],
    KECP: [30.36, -85.80], KECS: [43.88, -104.31], KEDC: [30.40, -97.57], KEDE: [36.03, -76.57], KEDN: [31.30, -85.90], KEDW: [34.91, -117.89],
    KEED: [34.77, -114.62], KEEN: [42.90, -72.27], KEET: [33.18, -86.78], KEFD: [29.61, -95.16], KEFK: [44.89, -72.23], KEFW: [42.01, -94.34],
    KEGE: [39.64, -106.92], KEGI: [30.65, -86.52], KEGV: [45.93, -89.27], KEK: [59.36, -157.47], KEKA: [40.80, -124.11], KEKM: [41.72, -86.00],
    KEKN: [38.89, -79.86], KEKO: [40.82, -115.79], KEKX: [37.69, -85.93], KELA: [29.60, -96.32], KELD: [33.22, -92.81], KELK: [35.43, -99.39],
    KELM: [42.16, -76.89], KELN: [47.03, -120.53], KELO: [47.82, -91.83], KELP: [31.81, -106.38], KELY: [39.30, -114.84], KELZ: [42.11, -77.99],
    KEMM: [41.82, -110.56], KEMP: [38.33, -96.19], KEMT: [34.09, -118.04], KEND: [36.34, -97.92], KENL: [38.52, -89.09], KENV: [40.72, -114.03],
    KENW: [42.60, -87.93], KEOK: [40.46, -91.43], KEOS: [36.81, -94.39], KEPH: [47.31, -119.52], KEQA: [37.77, -96.82], KERI: [42.08, -80.17],
    KERR: [44.79, -71.16], KERV: [29.98, -99.09], KESC: [45.72, -87.09], KESF: [31.39, -92.29], KESN: [38.80, -76.07], KEST: [43.41, -94.75],
    KESW: [47.25, -121.19], KETB: [43.42, -88.13], KETN: [32.41, -98.81], KEUF: [31.95, -85.13], KEUG: [44.12, -123.21], KEVM: [47.42, -92.50],
    KEVV: [38.04, -87.53], KEVW: [41.27, -111.04], KEWB: [41.68, -70.96], KEWK: [38.06, -97.27], KEWN: [35.07, -77.04], KEWR: [40.69, -74.17],
    KEYW: [24.56, -81.76], KF70: [33.57, -117.13], KFAF: [37.13, -76.61], KFAM: [37.76, -90.43], KFAR: [46.92, -96.82], KFAT: [36.78, -119.72],
    KFAY: [34.99, -78.88], KFBG: [35.13, -78.94], KFBL: [44.33, -93.31], KFBR: [41.39, -110.41], KFBY: [40.18, -97.17], KFCH: [36.73, -119.82],
    KFCM: [44.83, -93.46], KFCS: [38.68, -104.76], KFCY: [34.94, -90.78], KFDK: [39.42, -77.37], KFDR: [34.35, -98.98], KFDY: [41.01, -83.67],
    KFEP: [42.25, -89.58], KFET: [41.45, -96.52], KFFA: [36.02, -75.67], KFFL: [41.05, -91.98], KFFM: [46.28, -96.16], KFFO: [39.83, -84.05],
    KFFT: [38.18, -84.91], KFFZ: [33.46, -111.73], KFHR: [48.52, -123.02], KFHU: [31.59, -110.35], KFKL: [41.38, -79.86], KFKN: [36.70, -76.90],
    KFLD: [43.77, -88.49], KFLG: [35.14, -111.67], KFLL: [26.07, -80.15], KFLO: [34.19, -79.72], KFLP: [36.29, -92.59], KFLV: [39.37, -94.91],
    KFLX: [39.50, -118.75], KFME: [39.09, -76.76], KFMH: [41.66, -70.52], KFMN: [36.74, -108.23], KFMY: [26.59, -81.86], KFNL: [40.45, -105.01],
    KFNT: [42.97, -83.74], KFOD: [42.55, -94.19], KFOE: [38.95, -95.66], KFOK: [40.84, -72.63], KFOM: [38.96, -112.36], KFPR: [27.50, -80.37],
    KFPY: [30.07, -83.58], KFRG: [40.73, -73.41], KFRH: [38.51, -86.64], KFRI: [39.05, -96.76], KFRM: [43.64, -94.42], KFRR: [38.92, -78.25],
    KFSD: [43.59, -96.74], KFSI: [34.65, -98.40], KFSK: [37.80, -94.77], KFSM: [35.34, -94.37], KFST: [30.92, -102.92], KFSU: [34.48, -104.22],
    KFSW: [40.66, -91.33], KFTK: [37.91, -85.97], KFTW: [32.82, -97.36], KFTY: [33.78, -84.52], KFUL: [33.87, -117.98], KFVE: [47.29, -68.31],
    KFWA: [40.98, -85.19], KFXE: [26.20, -80.17], KFXY: [43.23, -93.62], KFYM: [35.06, -86.56], KFYV: [36.01, -94.17], KGAB: [38.92, -117.96],
    KGAD: [33.97, -86.09], KGAG: [36.30, -99.78], KGAI: [39.17, -77.17], KGBD: [38.34, -98.86], KGBG: [40.94, -90.43], KGBR: [42.18, -73.40],
    KGCC: [44.35, -105.54], KGCD: [44.40, -118.96], KGCK: [37.93, -100.72], KGCN: [35.95, -112.15], KGCY: [36.20, -82.81], KGDM: [42.55, -72.02],
    KGDV: [47.14, -104.81], KGDW: [43.97, -84.47], KGED: [38.69, -75.36], KGEG: [47.62, -117.53], KGEY: [44.52, -108.08], KGFD: [39.79, -85.74],
    KGFK: [47.95, -97.18], KGFL: [43.34, -73.61], KGGE: [33.31, -79.32], KGGG: [32.38, -94.71], KGGW: [48.21, -106.61], KGHM: [35.84, -87.45],
    KGIC: [45.94, -116.12], KGIF: [28.06, -81.75], KGJT: [39.13, -108.53], KGKJ: [41.63, -80.21], KGKT: [35.86, -83.53], KGLD: [39.37, -101.70],
    KGLE: [33.65, -97.20], KGLH: [33.48, -90.99], KGLR: [45.01, -84.70], KGLS: [29.27, -94.86], KGLW: [37.03, -85.95], KGMU: [34.85, -82.35],
    KGNG: [42.92, -114.76], KGNT: [35.17, -107.90], KGNV: [29.69, -82.27], KGOK: [35.85, -97.42], KGON: [41.33, -72.05], KGPI: [48.31, -114.26],
    KGPT: [30.41, -89.07], KGPZ: [47.21, -93.51], KGQQ: [40.75, -82.72], KGRB: [44.48, -88.13], KGRD: [34.25, -82.16], KGRE: [38.84, -89.38],
    KGRF: [47.08, -122.58], KGRI: [40.97, -98.31], KGRK: [31.07, -97.83], KGRN: [42.81, -102.18], KGRR: [42.88, -85.52], KGSB: [35.34, -77.96],
    KGSH: [41.53, -85.79], KGSO: [36.10, -79.94], KGSP: [34.90, -82.22], KGTB: [44.06, -75.72], KGTF: [47.48, -111.37], KGTG: [45.80, -92.66],
    KGTR: [33.45, -88.59], KGUC: [38.53, -106.93], KGUP: [35.51, -108.79], KGUS: [40.65, -86.15], KGUY: [36.69, -101.51], KGVE: [38.16, -78.17],
    KGVL: [34.27, -83.83], KGVT: [33.07, -96.07], KGWO: [33.50, -90.09], KGWS: [39.51, -107.31], KGXY: [40.44, -104.63], KGYH: [34.76, -82.38],
    KGYI: [33.71, -96.67], KGYR: [33.42, -112.38], KGYY: [41.62, -87.41], KGZ: [61.46, -142.38], KHAB: [34.12, -88.00], KHAF: [37.51, -122.50],
    KHAI: [41.96, -85.59], KHAO: [39.36, -84.52], KHBG: [31.26, -89.25], KHBR: [34.99, -99.05], KHDE: [40.45, -99.34], KHDN: [40.48, -107.22],
    KHEE: [34.58, -90.68], KHEF: [38.72, -77.52], KHEZ: [31.61, -91.30], KHFD: [41.74, -72.65], KHFF: [35.04, -79.50], KHGR: [39.71, -77.73],
    KHHR: [33.92, -118.33], KHHW: [34.03, -95.54], KHIB: [47.38, -92.84], KHIE: [44.37, -71.55], KHIF: [41.12, -111.97], KHII: [34.57, -114.36],
    KHIO: [45.54, -122.95], KHKA: [35.94, -89.83], KHKS: [32.33, -90.22], KHKY: [35.74, -81.39], KHLB: [39.34, -85.26], KHLC: [39.38, -99.83],
    KHLG: [40.17, -80.65], KHLN: [46.61, -111.98], KHMN: [32.85, -106.11], KHMT: [33.73, -117.02], KHNB: [38.25, -86.95], KHND: [35.97, -115.13],
    KHOB: [32.69, -103.22], KHON: [44.39, -98.23], KHOP: [36.67, -87.49], KHOT: [34.48, -93.10], KHOU: [29.65, -95.28], KHPN: [41.07, -73.71],
    KHPT: [42.72, -93.23], KHPY: [29.79, -94.95], KHQM: [46.97, -123.94], KHRI: [45.83, -119.26], KHRL: [26.23, -97.65], KHRO: [36.26, -93.15],
    KHRT: [30.43, -86.69], KHSB: [37.81, -88.55], KHSE: [35.23, -75.62], KHSG: [43.71, -108.39], KHSI: [40.61, -98.43], KHSP: [37.95, -79.83],
    KHST: [25.49, -80.38], KHSV: [34.64, -86.77], KHTH: [38.54, -118.63], KHTL: [44.36, -84.67], KHTS: [38.37, -82.56], KHTW: [38.42, -82.49],
    KHUA: [34.68, -86.68], KHUF: [39.45, -87.31], KHUL: [46.12, -67.79], KHUM: [29.57, -90.66], KHUT: [38.07, -97.86], KHVE: [38.42, -110.70],
    KHVN: [41.26, -72.89], KHVR: [48.54, -109.76], KHVS: [34.40, -80.12], KHWD: [37.66, -122.12], KHWO: [26.00, -80.24], KHWV: [40.82, -72.87],
    KHXD: [32.22, -80.70], KHYA: [41.67, -70.28], KHYI: [29.89, -97.86], KHYR: [46.03, -91.44], KHYS: [38.84, -99.27], KHZL: [40.99, -75.99],
    KHZY: [41.78, -80.70], KI20: [38.85, -87.50], KIAB: [37.62, -97.27], KIAD: [38.94, -77.46], KIAG: [43.11, -78.95], KIAH: [29.98, -95.34],
    KICL: [40.72, -95.03], KICT: [37.65, -97.43], KIDA: [43.51, -112.07], KIDG: [42.33, -95.44], KIDI: [40.63, -79.10], KIDP: [37.16, -95.78],
    KIEN: [43.02, -102.51], KIFA: [42.47, -93.27], KIFP: [35.15, -114.56], KIGM: [35.26, -113.94], KIJX: [39.77, -90.24], KIKK: [41.07, -87.85],
    KILE: [31.09, -97.69], KILG: [39.68, -75.61], KILM: [34.27, -77.91], KILN: [39.43, -83.79], KIML: [40.51, -101.62], KIMM: [26.43, -81.40],
    KIMS: [38.76, -85.47], KIMT: [45.82, -88.11], KIND: [39.72, -86.29], KINK: [31.78, -103.20], KINL: [48.57, -93.40], KINS: [36.59, -115.67],
    KINT: [36.13, -80.22], KINW: [35.02, -110.72], KIOW: [41.64, -91.55], KIPL: [32.84, -115.57], KIPT: [41.24, -76.92], KIRK: [40.09, -92.54],
    KIRS: [41.81, -85.44], KISM: [28.29, -81.44], KISO: [35.33, -77.61], KISP: [40.80, -73.10], KISQ: [45.97, -86.17], KISW: [44.36, -89.84],
    KITH: [42.49, -76.46], KIUA: [42.91, -77.33], KIWA: [33.31, -111.65], KIWD: [46.53, -90.13], KIWI: [43.96, -69.71], KIWS: [29.82, -95.67],
    KIXD: [38.83, -94.89], KIYK: [35.66, -117.83], KIZA: [34.61, -120.08], KIZG: [43.99, -70.95], KJAC: [43.61, -110.74], KJAN: [32.31, -90.08],
    KJAS: [30.89, -94.03], KJAX: [30.49, -81.69], KJBR: [35.83, -90.65], KJCT: [30.51, -99.76], KJDN: [47.33, -106.95], KJEF: [38.59, -92.16],
    KJFK: [40.64, -73.78], KJHW: [42.15, -79.25], KJKA: [30.29, -87.67], KJKL: [37.59, -83.32], KJLN: [37.15, -94.50], KJMS: [46.93, -98.68],
    KJNX: [35.54, -78.39], KJOT: [41.52, -88.18], KJPX: [40.96, -72.25], KJQF: [35.39, -80.71], KJSO: [31.87, -95.22], KJST: [40.32, -78.83],
    KJVL: [42.62, -89.04], KJWY: [32.46, -96.91], KJXN: [42.26, -84.46], KK23: [42.63, -74.89], KKIC: [36.23, -121.12], KKLS: [46.12, -122.90],
    KKNB: [37.01, -112.53], KKU: [58.81, -158.56], KL06: [36.46, -116.88], KL35: [34.26, -116.86], KL37: [35.53, -113.25], KL41: [36.81, -111.65],
    KL45: [35.32, -119.00], KL71: [35.15, -118.02], KLAA: [38.07, -102.69], KLAF: [40.41, -86.94], KLAL: [27.99, -82.02], KLAM: [35.88, -106.27],
    KLAN: [42.78, -84.59], KLAR: [41.31, -105.68], KLAS: [36.08, -115.15], KLAW: [34.57, -98.42], KLAX: [33.94, -118.41], KLBB: [33.66, -101.82],
    KLBE: [40.28, -79.40], KLBF: [41.13, -100.68], KLBL: [37.04, -100.96], KLBT: [34.61, -79.06], KLBX: [29.11, -95.46], KLCH: [30.13, -93.22],
    KLCI: [43.57, -71.42], KLCK: [39.81, -82.93], KLCQ: [30.18, -82.58], KLDJ: [40.62, -74.24], KLDM: [43.96, -86.41], KLEB: [43.63, -72.30],
    KLEE: [28.82, -81.81], KLEM: [45.92, -102.11], KLEW: [44.05, -70.28], KLEX: [38.04, -84.61], KLFI: [37.08, -76.36], KLFK: [31.23, -94.75],
    KLFT: [30.21, -91.99], KLGA: [40.78, -73.87], KLGB: [33.82, -118.15], KLGC: [33.01, -85.07], KLGD: [45.29, -118.01], KLGF: [32.86, -114.40],
    KLGU: [41.79, -111.85], KLHV: [41.14, -77.42], KLHW: [31.89, -81.56], KLHZ: [36.02, -78.33], KLIC: [39.27, -103.67], KLIT: [34.73, -92.22],
    KLKP: [44.26, -73.96], KLKU: [38.01, -77.97], KLKV: [42.16, -120.40], KLLJ: [44.52, -114.22], KLLQ: [33.64, -91.75], KLMS: [33.15, -89.06],
    KLMT: [42.16, -121.73], KLNA: [26.59, -80.09], KLND: [42.82, -108.73], KLNK: [40.84, -96.76], KLNN: [41.68, -81.39], KLNP: [36.99, -82.53],
    KLNR: [43.21, -90.18], KLNS: [40.12, -76.30], KLOL: [40.07, -118.57], KLOM: [40.14, -75.27], KLOT: [41.61, -88.10], KLOU: [38.23, -85.66],
    KLOZ: [37.08, -84.08], KLPC: [34.67, -120.47], KLQK: [34.81, -82.70], KLRD: [27.54, -99.46], KLRF: [34.92, -92.15], KLRJ: [42.78, -96.19],
    KLRU: [32.29, -106.92], KLSB: [32.33, -108.69], KLSE: [43.88, -91.26], KLSF: [32.33, -84.99], KLSK: [42.75, -104.40], KLSN: [37.06, -120.87],
    KLSV: [36.24, -115.03], KLTS: [34.67, -99.27], KLUF: [33.53, -112.38], KLUK: [39.10, -84.42], KLUL: [31.67, -89.17], KLVK: [37.69, -121.82],
    KLVL: [36.77, -77.79], KLVM: [45.70, -110.45], KLVS: [35.65, -105.14], KLWB: [37.86, -80.40], KLWC: [39.01, -95.22], KLWL: [41.12, -114.92],
    KLWM: [42.72, -71.12], KLWS: [46.37, -117.01], KLWT: [47.05, -109.47], KLWV: [38.76, -87.61], KLXN: [40.79, -99.78], KLXV: [39.22, -106.32],
    KLYH: [37.33, -79.20], KLYO: [38.34, -98.23], KLZU: [33.98, -83.96], KM75: [48.37, -107.92], KMAC: [32.82, -83.56], KMAE: [36.99, -120.11],
    KMAF: [31.94, -102.20], KMAW: [36.60, -89.99], KMBG: [45.55, -100.41], KMBL: [44.27, -86.25], KMBO: [32.44, -90.10], KMBS: [43.53, -84.08],
    KMBY: [39.46, -92.43], KMCB: [31.18, -90.47], KMCC: [38.67, -121.40], KMCD: [45.86, -84.64], KMCE: [37.28, -120.51], KMCF: [27.85, -82.52],
    KMCI: [39.30, -94.71], KMCK: [40.21, -100.59], KMCN: [32.69, -83.65], KMCO: [28.43, -81.31], KMCW: [43.16, -93.33], KMDD: [32.04, -102.10],
    KMDH: [37.78, -89.25], KMDS: [44.02, -97.09], KMDT: [40.19, -76.76], KMDW: [41.79, -87.75], KMDZ: [45.10, -90.30], KMEB: [34.79, -79.37],
    KMEI: [32.33, -88.75], KMEM: [35.04, -89.98], KMER: [37.38, -120.57], KMEV: [39.00, -119.75], KMEZ: [34.55, -94.20], KMFD: [40.82, -82.52],
    KMFE: [26.18, -98.24], KMFI: [44.64, -90.19], KMFR: [42.37, -122.87], KMFV: [37.65, -75.76], KMGC: [41.70, -86.82], KMGE: [33.92, -84.52],
    KMGJ: [41.51, -74.26], KMGM: [32.30, -86.39], KMGR: [31.08, -83.80], KMGW: [39.64, -79.92], KMGY: [39.59, -84.22], KMHE: [43.77, -98.04],
    KMHK: [39.14, -96.67], KMHL: [39.10, -93.20], KMHR: [38.55, -121.30], KMHT: [42.93, -71.44], KMHV: [35.06, -118.15], KMIA: [25.80, -80.29],
    KMIB: [48.42, -101.36], KMIC: [45.06, -93.35], KMIE: [40.24, -85.40], KMIO: [36.91, -94.89], KMIT: [35.51, -119.19], KMIV: [39.37, -75.07],
    KMIW: [42.11, -92.92], KMJQ: [43.65, -94.99], KMJX: [39.93, -74.29], KMKC: [39.12, -94.59], KMKE: [42.95, -87.90], KMKG: [43.17, -86.24],
    KMKL: [35.60, -88.92], KMKO: [35.66, -95.37], KMKT: [44.22, -93.92], KMKY: [26.00, -81.67], KMLB: [28.10, -80.64], KMLC: [34.88, -95.78],
    KMLD: [42.17, -112.30], KMLE: [41.20, -96.11], KMLF: [38.43, -113.01], KMLI: [41.45, -90.51], KMLJ: [33.15, -83.24], KMLS: [46.43, -105.89],
    KMLT: [45.65, -68.69], KMLU: [32.51, -92.04], KMMH: [37.63, -118.84], KMMI: [35.40, -84.56], KMML: [44.45, -95.82], KMMS: [34.23, -90.29],
    KMMT: [33.92, -80.80], KMMU: [40.80, -74.41], KMMV: [45.19, -123.14], KMNM: [45.13, -87.64], KMNN: [40.62, -83.06], KMOB: [30.69, -88.24],
    KMOD: [37.63, -120.95], KMOP: [43.62, -84.74], KMOR: [36.18, -83.38], KMOT: [48.26, -101.28], KMOX: [45.57, -95.97], KMPI: [37.51, -120.04],
    KMPJ: [35.14, -92.91], KMPO: [41.14, -75.38], KMPR: [38.35, -97.69], KMPV: [44.20, -72.56], KMPZ: [40.95, -91.51], KMQB: [40.52, -90.65],
    KMQI: [35.92, -75.70], KMQS: [39.98, -75.87], KMQW: [32.10, -82.88], KMQY: [36.01, -86.52], KMRB: [39.40, -77.98], KMRC: [35.55, -87.18],
    KMRF: [30.37, -104.02], KMRN: [35.82, -81.61], KMRY: [36.59, -121.84], KMSL: [34.75, -87.61], KMSN: [43.14, -89.34], KMSO: [46.92, -114.09],
    KMSP: [44.88, -93.22], KMSS: [44.94, -74.84], KMSV: [41.70, -74.79], KMSY: [29.99, -90.26], KMTC: [42.61, -82.84], KMTH: [24.73, -81.05],
    KMTJ: [38.51, -107.89], KMTN: [39.33, -76.41], KMTO: [39.48, -88.28], KMTP: [41.08, -71.92], KMTW: [44.13, -87.68], KMUI: [40.44, -76.57],
    KMUL: [31.14, -83.70], KMUO: [43.04, -115.87], KMUT: [41.37, -91.15], KMVC: [31.46, -87.35], KMVE: [44.97, -95.71], KMVL: [44.53, -72.61],
    KMVN: [38.32, -88.86], KMVY: [41.39, -70.61], KMWA: [37.75, -89.02], KMWC: [43.11, -88.03], KMWH: [47.21, -119.32], KMWL: [32.78, -98.06],
    KMWM: [43.91, -95.11], KMWO: [39.53, -84.40], KMXA: [35.89, -90.15], KMXF: [32.38, -86.37], KMXO: [42.22, -91.16], KMYF: [32.82, -117.14],
    KMYK: [61.34, -142.69], KMYL: [44.89, -116.10], KMYR: [33.68, -78.93], KMYV: [39.10, -121.57], KMZJ: [32.51, -111.33], KMZZ: [40.49, -85.68],
    KN03: [42.59, -76.21], KN66: [42.52, -75.06], KNBC: [32.48, -80.72], KNBG: [29.83, -90.04], KNBJ: [30.39, -87.64], KNCA: [34.71, -77.44],
    KNDY: [38.33, -77.04], KNDZ: [30.70, -87.02], KNEL: [40.03, -74.35], KNEN: [30.35, -81.87], KNEW: [30.04, -90.03], KNFG: [33.30, -117.36],
    KNFL: [39.42, -118.70], KNFW: [32.77, -97.44], KNGP: [27.69, -97.29], KNGU: [36.94, -76.29], KNGW: [27.70, -97.44], KNHK: [38.29, -76.41],
    KNID: [35.69, -117.69], KNIP: [30.24, -81.68], KNJK: [32.83, -115.67], KNKT: [34.90, -76.88], KNKX: [32.87, -117.14], KNLC: [36.33, -119.95],
    KNMM: [32.55, -88.55], KNPA: [30.35, -87.32], KNQA: [35.36, -89.87], KNQI: [27.51, -97.81], KNQX: [24.58, -81.69], KNRB: [30.39, -81.42],
    KNRS: [32.57, -117.12], KNSE: [30.72, -87.02], KNTD: [34.12, -119.12], KNTU: [36.82, -76.03], KNUQ: [37.42, -122.05], KNUW: [48.35, -122.66],
    KNVD: [37.85, -94.30], KNXP: [34.30, -116.16], KNYG: [38.50, -77.31], KNYL: [32.65, -114.61], KNZY: [32.70, -117.21], KO02: [39.82, -120.35],
    KOAJ: [34.83, -77.61], KOAK: [37.72, -122.22], KOAR: [36.68, -121.76], KOBE: [27.26, -80.85], KOCF: [29.17, -82.22], KOCH: [31.58, -94.71],
    KOCW: [35.57, -77.05], KODO: [31.92, -102.39], KOEA: [38.69, -87.54], KOEO: [45.31, -92.69], KOFF: [41.12, -95.91], KOFK: [41.99, -97.44],
    KOGA: [41.12, -101.77], KOGB: [33.46, -80.86], KOGD: [41.20, -112.01], KOGS: [44.68, -75.47], KOIC: [42.57, -75.52], KOJC: [38.85, -94.74],
    KOKB: [33.22, -117.35], KOKC: [35.39, -97.60], KOKH: [48.25, -122.67], KOKK: [40.53, -86.06], KOKM: [35.67, -95.95], KOKS: [41.40, -102.36],
    KOKV: [39.14, -78.14], KOLD: [44.95, -68.67], KOLE: [42.24, -78.37], KOLF: [48.09, -105.57], KOLM: [46.97, -122.90], KOLS: [31.42, -110.85],
    KOLU: [41.45, -97.34], KOLV: [34.98, -89.79], KOLY: [38.72, -88.18], KOMA: [41.30, -95.89], KOMK: [48.46, -119.52], KONA: [44.08, -91.71],
    KONL: [42.47, -98.69], KONM: [34.02, -106.90], KONO: [44.02, -117.01], KONP: [44.58, -124.06], KONT: [34.06, -117.60], KONY: [33.35, -98.82],
    KOOA: [41.23, -92.49], KOPF: [25.91, -80.28], KOPL: [30.56, -92.10], KOQU: [41.60, -71.41], KORD: [41.98, -87.90], KORF: [36.90, -76.20],
    KORH: [42.27, -71.88], KORL: [28.55, -81.33], KORS: [48.71, -122.91], KOSA: [33.10, -94.96], KOSC: [44.45, -83.39], KOSH: [43.98, -88.56],
    KOSU: [40.08, -83.07], KOSX: [33.09, -89.54], KOTG: [43.65, -95.58], KOTH: [43.42, -124.25], KOTM: [41.11, -92.45], KOUN: [35.25, -97.47],
    KOVE: [39.49, -121.62], KOWA: [44.12, -93.26], KOWB: [37.74, -87.17], KOWD: [42.19, -71.17], KOWK: [44.72, -69.87], KOXB: [38.31, -75.12],
    KOXC: [41.48, -73.14], KOXD: [39.50, -84.78], KOXR: [34.20, -119.21], KOYM: [41.41, -78.50], KOZA: [30.74, -101.20], KOZR: [31.28, -85.71],
    KP13: [33.35, -110.67], KP33: [32.25, -109.89], KP52: [34.73, -112.04], KPAE: [47.91, -122.28], KPAH: [37.06, -88.77], KPAM: [30.07, -85.58],
    KPAN: [34.26, -111.34], KPAO: [37.46, -122.11], KPBF: [34.17, -91.94], KPBG: [44.65, -73.47], KPBI: [26.68, -80.10], KPBX: [37.56, -82.57],
    KPCW: [41.52, -82.87], KPDC: [43.02, -91.12], KPDK: [33.88, -84.30], KPDT: [45.70, -118.84], KPDX: [45.59, -122.60], KPEQ: [31.38, -103.51],
    KPFC: [45.20, -123.96], KPGA: [36.92, -111.45], KPGD: [26.92, -81.99], KPGR: [36.06, -90.51], KPGV: [35.64, -77.38], KPHD: [40.47, -81.42],
    KPHF: [37.13, -76.49], KPHH: [33.45, -79.53], KPHK: [26.78, -80.69], KPHL: [39.87, -75.24], KPHN: [42.91, -82.53], KPHP: [44.05, -101.60],
    KPHT: [36.34, -88.38], KPHX: [33.44, -112.01], KPIA: [40.66, -89.69], KPIB: [31.47, -89.34], KPIE: [27.91, -82.69], KPIH: [42.91, -112.60],
    KPIM: [32.84, -84.88], KPIR: [44.38, -100.29], KPIT: [40.49, -80.23], KPKB: [39.35, -81.44], KPKD: [46.90, -95.07], KPKF: [45.96, -90.42],
    KPLK: [36.63, -93.23], KPLN: [45.57, -84.80], KPLR: [33.56, -86.25], KPMB: [48.94, -97.24], KPMD: [34.63, -118.08], KPMH: [38.84, -82.85],
    KPMP: [26.25, -80.11], KPNA: [42.80, -109.81], KPNC: [36.73, -97.10], KPNE: [40.08, -75.01], KPNN: [45.20, -67.56], KPNS: [30.47, -87.19],
    KPOB: [35.17, -79.01], KPOC: [34.09, -117.78], KPOE: [31.04, -93.19], KPOF: [36.77, -90.32], KPOH: [42.74, -94.65], KPOU: [41.63, -73.88],
    KPOY: [44.87, -108.79], KPPA: [35.61, -101.00], KPPF: [37.33, -95.51], KPPO: [41.57, -86.73], KPQI: [46.69, -68.04], KPQL: [30.46, -88.53],
    KPRB: [35.67, -120.63], KPRC: [34.65, -112.42], KPRO: [41.83, -94.16], KPRX: [33.64, -95.45], KPSB: [40.88, -78.09], KPSC: [46.26, -119.12],
    KPSF: [42.43, -73.29], KPSK: [37.14, -80.68], KPSM: [43.08, -70.82], KPSN: [31.78, -95.71], KPSO: [37.29, -107.06], KPSP: [33.83, -116.51],
    KPSX: [28.73, -96.25], KPTB: [37.18, -77.51], KPTK: [42.67, -83.42], KPTN: [29.71, -91.34], KPTS: [37.45, -94.73], KPTT: [37.70, -98.75],
    KPTV: [36.03, -119.06], KPTW: [40.24, -75.56], KPUB: [38.29, -104.50], KPUC: [39.61, -110.75], KPUW: [46.74, -117.11], KPVC: [42.07, -70.22],
    KPVD: [41.73, -71.43], KPVF: [38.72, -120.75], KPVU: [40.22, -111.72], KPVW: [34.17, -101.72], KPWA: [35.53, -97.65], KPWD: [48.79, -104.53],
    KPWK: [42.11, -87.90], KPWM: [43.65, -70.31], KPWT: [47.49, -122.76], KPYM: [41.91, -70.73], KRAC: [42.76, -87.82], KRAL: [33.95, -117.44],
    KRAP: [44.05, -103.06], KRBD: [32.68, -96.87], KRBG: [43.24, -123.36], KRBL: [40.15, -122.25], KRBW: [32.92, -80.64], KRCA: [44.15, -103.10],
    KRCK: [30.63, -96.99], KRCR: [41.07, -86.18], KRDD: [40.51, -122.29], KRDG: [40.38, -75.97], KRDM: [44.25, -121.15], KRDR: [47.96, -97.40],
    KRDU: [35.88, -78.79], KREO: [42.58, -117.89], KRFD: [42.20, -89.10], KRFG: [28.29, -97.32], KRGA: [37.63, -84.33], KRHI: [45.63, -89.47],
    KRHP: [35.20, -83.86], KRHV: [37.33, -121.82], KRIC: [37.51, -77.32], KRID: [39.76, -84.84], KRIF: [38.73, -112.10], KRIL: [39.53, -107.73],
    KRIR: [33.99, -117.41], KRIV: [33.88, -117.26], KRIW: [43.06, -108.46], KRKD: [44.06, -69.10], KRKP: [28.09, -97.04], KRKR: [35.02, -94.62],
    KRKS: [41.59, -109.07], KRKW: [35.92, -84.69], KRLD: [46.31, -119.30], KRME: [43.23, -75.41], KRMG: [34.35, -85.16], KRNC: [35.70, -85.84],
    KRND: [29.53, -98.28], KRNH: [45.15, -92.54], KRNO: [39.50, -119.77], KRNT: [47.49, -122.22], KROA: [37.33, -79.98], KROC: [43.12, -77.67],
    KROG: [36.37, -94.11], KROW: [33.30, -104.53], KROX: [48.86, -95.70], KRPD: [45.42, -91.77], KRPX: [46.48, -108.54], KRQB: [43.72, -85.50],
    KRQO: [35.47, -98.01], KRRL: [45.20, -89.71], KRRT: [48.94, -95.35], KRSL: [38.87, -98.81], KRSN: [32.51, -92.59], KRST: [43.91, -92.50],
    KRSW: [26.53, -81.75], KRTN: [36.74, -104.50], KRUQ: [35.65, -80.52], KRUT: [43.53, -72.95], KRVL: [40.68, -77.63], KRVS: [36.04, -95.98],
    KRWF: [44.55, -95.08], KRWI: [35.86, -77.89], KRWL: [41.81, -107.20], KRXE: [43.83, -111.81], KRYY: [34.01, -84.60], KRZL: [40.95, -87.18],
    KS03: [42.19, -122.66], KS21: [43.88, -121.45], KS33: [44.67, -121.15], KSAA: [41.44, -106.82], KSAC: [38.51, -121.49], KSAD: [32.85, -109.64],
    KSAF: [35.62, -106.09], KSAN: [32.73, -117.19], KSAR: [38.15, -89.70], KSAS: [33.24, -115.95], KSAT: [29.53, -98.47], KSAV: [32.13, -81.20],
    KSAW: [46.35, -87.40], KSBA: [34.43, -119.84], KSBD: [34.10, -117.24], KSBM: [43.77, -87.85], KSBN: [41.71, -86.32], KSBP: [35.24, -120.64],
    KSBS: [40.52, -106.87], KSBX: [48.54, -111.87], KSBY: [38.34, -75.51], KSCB: [41.61, -96.63], KSCH: [42.85, -73.93], KSCK: [37.89, -121.24],
    KSDF: [38.17, -85.74], KSDL: [33.62, -111.91], KSDM: [32.57, -116.98], KSDY: [47.71, -104.19], KSEA: [47.45, -122.31], KSEE: [32.83, -116.97],
    KSEF: [27.46, -81.34], KSEG: [40.82, -76.86], KSEM: [32.34, -86.99], KSEP: [32.22, -98.18], KSER: [38.92, -85.91], KSEZ: [34.85, -111.79],
    KSFB: [28.77, -81.23], KSFF: [47.68, -117.32], KSFM: [43.39, -70.71], KSFO: [37.62, -122.37], KSFZ: [41.92, -71.49], KSGF: [37.25, -93.39],
    KSGH: [39.84, -83.84], KSGJ: [29.96, -81.34], KSGR: [29.62, -95.66], KSGT: [34.60, -91.57], KSGU: [37.04, -113.51], KSHD: [38.26, -78.90],
    KSHN: [47.23, -123.15], KSHR: [44.77, -106.98], KSHV: [32.44, -93.83], KSIK: [36.90, -89.56], KSIV: [39.11, -87.45], KSIY: [41.78, -122.47],
    KSJC: [37.36, -121.93], KSJN: [34.52, -109.38], KSJT: [31.36, -100.50], KSJX: [45.69, -85.57], KSKA: [47.62, -117.66], KSKF: [29.38, -98.58],
    KSKX: [36.45, -105.68], KSLB: [42.60, -95.24], KSLC: [40.79, -111.98], KSLE: [44.91, -123.00], KSLG: [36.19, -94.49], KSLI: [33.79, -118.05],
    KSLK: [44.39, -74.20], KSLN: [38.79, -97.65], KSLO: [38.64, -88.96], KSLR: [33.16, -95.62], KSMD: [41.14, -85.15], KSME: [37.05, -84.62],
    KSMF: [38.70, -121.59], KSMN: [45.12, -113.88], KSMO: [34.02, -118.45], KSMS: [33.99, -80.36], KSMX: [34.90, -120.46], KSNA: [33.68, -117.87],
    KSNK: [32.69, -100.95], KSNL: [35.36, -96.94], KSNS: [36.66, -121.61], KSNY: [41.10, -102.99], KSOA: [30.59, -100.65], KSOP: [35.24, -79.39],
    KSOW: [34.26, -110.01], KSPA: [34.92, -81.96], KSPF: [44.48, -103.78], KSPG: [27.77, -82.63], KSPI: [39.84, -89.68], KSPS: [33.99, -98.49],
    KSPW: [43.17, -95.20], KSQI: [41.74, -89.67], KSQL: [37.51, -122.25], KSRC: [35.21, -91.74], KSRQ: [27.39, -82.55], KSRR: [33.46, -105.54],
    KSSC: [33.97, -80.47], KSSF: [29.34, -98.47], KSSI: [31.15, -81.39], KSTC: [45.55, -94.06], KSTE: [44.55, -89.53], KSTJ: [39.77, -94.91],
    KSTK: [40.61, -103.26], KSTL: [38.75, -90.37], KSTP: [44.93, -93.06], KSTS: [38.51, -122.81], KSUA: [27.18, -80.22], KSUD: [35.79, -96.66],
    KSUE: [44.84, -87.42], KSUN: [43.50, -114.30], KSUS: [38.66, -90.65], KSUU: [38.26, -121.93], KSUW: [46.69, -92.10], KSUX: [42.40, -96.38],
    KSUZ: [34.59, -92.48], KSVC: [32.64, -108.15], KSVE: [40.38, -120.57], KSVH: [35.77, -80.95], KSVN: [32.01, -81.15], KSVR: [40.62, -111.99],
    KSWF: [41.50, -74.11], KSWO: [36.16, -97.09], KSWW: [32.47, -100.47], KSYI: [35.56, -86.44], KSYN: [44.48, -93.02], KSYR: [43.11, -76.11],
    KSYV: [31.56, -83.90], KSZL: [38.73, -93.55], KSZN: [34.06, -119.92], KSZP: [34.35, -119.06], KT03: [36.09, -111.38], KT89: [29.28, -103.69],
    KTAD: [37.26, -104.34], KTBN: [37.74, -92.14], KTBR: [32.48, -81.74], KTCC: [35.18, -103.60], KTCL: [33.22, -87.61], KTCM: [47.14, -122.48],
    KTCS: [33.24, -107.27], KTDO: [46.48, -122.81], KTDW: [35.17, -101.83], KTDZ: [41.56, -83.48], KTEB: [40.85, -74.06], KTEX: [37.95, -107.91],
    KTHA: [35.38, -86.25], KTHM: [47.57, -115.28], KTHV: [39.92, -76.87], KTIK: [35.41, -97.39], KTIW: [47.27, -122.58], KTIX: [28.51, -80.80],
    KTKI: [33.18, -96.59], KTKX: [36.23, -90.04], KTLH: [30.40, -84.35], KTLR: [36.16, -119.33], KTMA: [31.43, -83.49], KTMB: [25.65, -80.43],
    KTMK: [45.42, -123.81], KTMT: [39.47, -117.20], KTNP: [34.13, -115.95], KTNT: [25.86, -80.90], KTNU: [41.67, -93.02], KTNX: [37.80, -116.78],
    KTOA: [33.80, -118.34], KTOC: [34.59, -83.30], KTOI: [31.86, -86.01], KTOL: [41.59, -83.81], KTOP: [39.07, -95.62], KTOR: [42.06, -104.15],
    KTPA: [27.98, -82.53], KTPF: [27.92, -82.45], KTPH: [38.06, -117.09], KTPL: [31.15, -97.41], KTRI: [36.48, -82.41], KTRK: [39.32, -120.14],
    KTRL: [32.71, -96.27], KTRM: [33.63, -116.16], KTRX: [40.08, -93.59], KTSP: [35.13, -118.44], KTTD: [45.55, -122.40], KTTN: [40.28, -74.81],
    KTTS: [28.61, -80.69], KTUL: [36.20, -95.89], KTUP: [34.27, -88.77], KTUS: [32.12, -110.94], KTVC: [44.74, -85.58], KTVF: [48.07, -96.18],
    KTVI: [30.90, -83.88], KTVL: [38.89, -120.00], KTWF: [42.48, -114.49], KTX2: [28.36, -97.66], KTXK: [33.45, -93.99], KTYL: [34.45, -110.11],
    KTYR: [32.35, -95.40], KTYS: [35.81, -83.99], KU07: [37.55, -110.71], KU14: [39.74, -111.87], KU34: [38.96, -110.23], KU41: [44.16, -112.22],
    KU70: [44.49, -116.02], KUAO: [45.25, -122.77], KUBS: [33.47, -88.38], KUCY: [36.38, -88.99], KUDD: [33.75, -116.28], KUES: [43.04, -88.24],
    KUGN: [42.42, -87.87], KUIL: [47.94, -124.56], KUIN: [39.94, -91.19], KUKF: [36.22, -81.10], KUKI: [39.13, -123.20], KUKT: [40.44, -75.38],
    KULM: [44.32, -94.50], KUNI: [39.21, -82.23], KUNU: [43.43, -88.70], KUNV: [40.85, -77.85], KUOS: [35.20, -85.90], KUOX: [34.38, -89.54],
    KUTA: [34.69, -90.35], KUTS: [30.75, -95.59], KUUU: [41.53, -71.28], KUVA: [29.21, -99.74], KUZA: [34.99, -81.06], KVAD: [30.97, -83.19],
    KVAY: [39.94, -74.85], KVBG: [34.74, -120.58], KVCT: [28.85, -96.92], KVCV: [34.60, -117.38], KVDI: [32.19, -82.37], KVEL: [40.44, -109.51],
    KVGT: [36.21, -115.19], KVHN: [31.06, -104.78], KVIH: [38.13, -91.77], KVIS: [36.32, -119.39], KVJI: [36.69, -82.03], KVKS: [32.24, -90.93],
    KVLA: [38.99, -89.17], KVLD: [30.78, -83.28], KVNC: [27.07, -82.44], KVNY: [34.21, -118.49], KVOK: [43.94, -90.25], KVPS: [30.48, -86.52],
    KVPZ: [41.45, -87.01], KVQQ: [30.22, -81.88], KVRB: [27.66, -80.42], KVSF: [43.34, -72.52], KVTN: [42.86, -100.55], KVYS: [41.35, -89.15],
    KW05: [39.84, -77.27], KW63: [36.60, -78.56], KWAL: [37.94, -75.46], KWAY: [39.90, -80.13], KWBW: [41.30, -75.85], KWDG: [36.38, -97.79],
    KWDR: [33.98, -83.67], KWEA: [32.75, -97.68], KWHP: [34.26, -118.41], KWJF: [34.74, -118.22], KWLD: [37.17, -97.04], KWLW: [39.52, -122.22],
    KWMC: [40.90, -117.81], KWRB: [32.64, -83.59], KWRI: [40.02, -74.59], KWRL: [43.97, -107.95], KWST: [41.35, -71.80], KWVI: [36.94, -121.79],
    KWVL: [44.53, -69.68], KWWD: [39.01, -74.91], KWWR: [36.44, -99.52], KWYS: [44.69, -111.12], KX51: [25.50, -80.55], KXMR: [28.47, -80.57],
    KXNA: [36.28, -94.31], KXTA: [37.24, -115.81], KXWA: [48.26, -103.75], KY31: [44.24, -84.18], KYIP: [42.24, -83.53], KYKM: [46.57, -120.54],
    KYKN: [42.92, -97.39], KYNG: [41.26, -80.68], KZPH: [28.23, -82.16], KZZV: [39.94, -81.89], L08: [33.26, -116.32], L72: [35.81, -117.33],
    LATI: [41.41, 19.72], LBBG: [42.57, 27.52], LBPD: [42.07, 24.85], LBSF: [42.70, 23.42], LBWN: [43.23, 27.83], LCEN: [35.15, 33.51],
    LCLK: [34.88, 33.62], LCPH: [34.72, 32.49], LDDU: [42.56, 18.27], LDPL: [44.89, 13.92], LDRI: [45.22, 14.57], LDSP: [43.54, 16.30],
    LDZA: [45.74, 16.07], LDZD: [44.10, 15.35], LEAL: [38.28, -0.56], LEAS: [43.56, -6.03], LEBB: [43.30, -2.91], LEBL: [41.30, 2.08],
    LEGE: [41.90, 2.76], LEIB: [38.87, 1.37], LEMD: [40.49, -3.57], LEMG: [36.67, -4.50], LEMH: [39.86, 4.22], LEMI: [37.80, -1.12],
    LEPA: [39.55, 2.74], LERS: [41.15, 1.17], LEST: [42.90, -8.42], LEVC: [39.49, -0.48], LEZG: [41.67, -1.04], LEZL: [37.42, -5.89],
    LFBD: [44.83, -0.72], LFBO: [43.63, 1.36], LFKB: [42.55, 9.48], LFKF: [41.50, 9.10], LFLC: [45.79, 3.17], LFLL: [45.73, 5.09],
    LFML: [43.44, 5.21], LFMN: [43.66, 7.22], LFMT: [43.58, 3.96], LFOB: [49.45, 2.11], LFPB: [48.96, 2.44], LFPG: [49.01, 2.55],
    LFPO: [48.73, 2.36], LFQQ: [50.57, 3.10], LFRB: [48.45, -4.42], LFRS: [47.15, -1.61], LFSB: [47.60, 7.52], LFST: [48.54, 7.63],
    LGAV: [37.94, 23.94], LGIR: [35.34, 25.18], LGKO: [36.79, 27.09], LGKR: [39.60, 19.91], LGKV: [40.91, 24.62], LGRP: [36.41, 28.09],
    LGSA: [35.53, 24.15], LGSR: [36.40, 25.48], LGTS: [40.52, 22.97], LHBP: [47.43, 19.26], LHDC: [47.49, 21.62], LHPP: [45.99, 18.24],
    LIBD: [41.14, 16.76], LIBP: [42.43, 14.18], LIBR: [40.66, 17.95], LICA: [38.91, 16.25], LICC: [37.47, 15.07], LICJ: [38.18, 13.09],
    LIEE: [39.25, 9.05], LIEO: [40.90, 9.52], LIMC: [45.63, 8.73], LIME: [45.67, 9.71], LIMF: [45.20, 7.65], LIMJ: [44.41, 8.84],
    LIML: [45.45, 9.28], LIPE: [44.54, 11.29], LIPH: [45.65, 12.19], LIPQ: [45.83, 13.47], LIPR: [44.02, 12.61], LIPX: [45.39, 10.89],
    LIPZ: [45.51, 12.35], LIRA: [41.80, 12.60], LIRF: [41.80, 12.25], LIRN: [40.89, 14.29], LIRP: [43.68, 10.39], LIRQ: [43.81, 11.20],
    LIRZ: [43.10, 12.51], LJLJ: [46.22, 14.46], LKCS: [48.95, 14.43], LKKV: [50.20, 12.91], LKMT: [49.70, 18.11], LKPD: [50.02, 15.74],
    LKPR: [50.10, 14.26], LLBG: [32.01, 34.89], LLER: [29.73, 35.01], LMML: [35.85, 14.49], LOWG: [46.99, 15.44], LOWI: [47.26, 11.34],
    LOWK: [46.64, 14.34], LOWL: [48.24, 14.19], LOWS: [47.79, 13.00], LOWW: [48.11, 16.57], LPFR: [37.02, -7.97], LPMA: [32.70, -16.77],
    LPPD: [37.74, -25.70], LPPR: [41.25, -8.68], LPPT: [38.78, -9.14], LQBK: [44.94, 17.30], LQMO: [43.28, 17.85], LQSA: [43.82, 18.33],
    LQTZ: [44.46, 18.72], LRBC: [46.52, 26.91], LRBS: [44.50, 26.10], LRBV: [45.71, 25.52], LRCK: [44.36, 28.49], LRCL: [46.79, 23.69],
    LRCV: [44.32, 23.89], LRIA: [47.18, 27.62], LROD: [47.03, 21.90], LROP: [44.57, 26.10], LRSB: [45.79, 24.09], LRSV: [47.69, 26.35],
    LRTR: [45.81, 21.34], LSGG: [46.24, 6.11], LSZH: [47.46, 8.55], LTAC: [40.13, 33.00], LTAI: [36.90, 30.80], LTAJ: [36.95, 37.48],
    LTAN: [37.98, 32.56], LTAU: [38.77, 35.50], LTAZ: [38.77, 34.53], LTBA: [40.97, 28.82], LTBJ: [38.29, 27.16], LTBS: [36.71, 28.79],
    LTBY: [39.81, 30.52], LTCS: [37.45, 38.90], LTDB: [36.89, 35.07], LTFD: [39.55, 27.01], LTFE: [37.25, 27.66], LTFJ: [40.90, 29.31],
    LTFM: [41.27, 28.73], LTFO: [41.18, 40.85], LUKK: [46.93, 28.93], LWOH: [41.18, 20.74], LWSK: [41.96, 21.62], LXGB: [36.15, -5.35],
    LYBE: [44.82, 20.31], LYNI: [43.34, 21.86], LYPG: [42.36, 19.25], LZIB: [48.17, 17.21], M13: [30.79, -89.50], M26: [46.62, -113.20],
    MA53: [42.28, -72.21], MBGT: [21.44, -71.14], MBNC: [21.92, -71.94], MBPV: [21.77, -72.27], MBSC: [21.52, -71.53], MDBH: [18.25, -71.12],
    MDCR: [17.93, -71.64], MDCY: [19.27, -69.74], MDJB: [18.57, -69.99], MDLR: [18.45, -68.91], MDPC: [18.57, -68.36], MDPP: [19.76, -70.57],
    MDSD: [18.43, -69.67], MDSI: [18.50, -69.76], MDST: [19.40, -70.60], ME16: [46.95, -67.89], MGCB: [15.47, -90.41], MGGT: [14.58, -90.53],
    MGI: [28.32, -96.46], MGMM: [16.91, -89.87], MGPB: [15.73, -88.58], MGRB: [15.99, -90.45], MGRT: [14.52, -91.70], MGSJ: [13.94, -90.84],
    MHLC: [15.74, -86.85], MHLM: [15.45, -87.92], MHN: [42.04, -101.06], MHNJ: [16.45, -85.91], MHPR: [14.38, -87.62], MHRO: [16.32, -86.52],
    MHTE: [15.78, -87.48], MHTG: [14.06, -87.22], MHTJ: [15.93, -85.94], MKBS: [18.40, -76.97], MKJP: [17.94, -76.79], MKJS: [18.50, -77.91],
    MKKJ: [18.20, -76.53], MKTP: [17.99, -76.82], MMAA: [16.76, -99.75], MMAN: [25.87, -100.24], MMAS: [21.70, -102.32], MMBT: [15.78, -96.26],
    MMCB: [18.83, -99.26], MMCC: [29.33, -101.10], MMCE: [18.65, -91.80], MMCL: [24.77, -107.48], MMCM: [18.50, -88.33], MMCN: [27.39, -109.83],
    MMCP: [19.82, -90.50], MMCS: [31.64, -106.43], MMCU: [28.70, -105.96], MMCV: [23.70, -98.96], MMCY: [20.55, -100.89], MMCZ: [20.51, -86.93],
    MMDO: [24.13, -104.53], MMEP: [21.42, -104.84], MMES: [31.79, -116.60], MMGA: [27.73, -107.65], MMGL: [20.52, -103.31], MMGM: [27.97, -110.93],
    MMHO: [29.09, -111.05], MMIA: [19.28, -103.58], MMIO: [25.54, -100.93], MMIT: [16.45, -95.09], MMJA: [19.48, -96.80], MMLC: [18.00, -102.22],
    MMLM: [25.69, -109.08], MMLO: [20.99, -101.48], MMLP: [24.07, -110.36], MMLT: [25.99, -111.35], MMMA: [25.77, -97.53], MMMD: [20.93, -89.65],
    MMML: [32.63, -115.24], MMMM: [19.85, -101.03], MMMT: [18.10, -94.58], MMMV: [26.96, -101.47], MMMX: [19.44, -99.07], MMMY: [25.78, -100.11],
    MMMZ: [23.16, -106.26], MMNG: [31.23, -110.98], MMNL: [27.44, -99.57], MMOX: [17.00, -96.73], MMPA: [20.60, -97.46], MMPB: [19.16, -98.37],
    MMPG: [28.63, -100.54], MMPN: [19.40, -102.04], MMPR: [20.68, -105.25], MMPS: [15.88, -97.09], MMQT: [20.62, -100.19], MMRX: [26.01, -98.23],
    MMSD: [23.15, -109.72], MMSL: [22.95, -109.94], MMSM: [19.74, -99.02], MMSP: [22.26, -100.94], MMTB: [16.74, -93.17], MMTC: [25.56, -103.40],
    MMTG: [16.56, -93.03], MMTJ: [32.54, -116.97], MMTL: [20.17, -87.66], MMTM: [22.29, -97.87], MMTO: [19.34, -99.57], MMTP: [14.79, -92.37],
    MMUN: [21.04, -86.87], MMVA: [17.99, -92.82], MMVR: [19.14, -96.19], MMZC: [22.89, -102.69], MMZH: [17.60, -101.46], MMZO: [19.14, -104.56],
    MNBL: [11.99, -83.77], MNMG: [12.14, -86.17], MNPC: [14.05, -83.39], MOS: [64.69, -162.06], MPBO: [9.34, -82.25], MPCE: [7.99, -80.41],
    MPCH: [9.46, -82.52], MPDA: [8.39, -82.44], MPEJ: [9.36, -79.87], MPMG: [8.97, -79.56], MPSA: [8.09, -80.95], MPTO: [9.07, -79.38],
    MRAN: [10.47, -84.58], MRAO: [10.42, -83.61], MRBA: [9.16, -83.33], MRBC: [10.77, -83.59], MRCC: [8.60, -82.97], MRGF: [8.65, -83.18],
    MRGP: [10.22, -83.80], MRLB: [10.59, -85.54], MRLC: [11.04, -84.71], MRLM: [9.96, -83.02], MRNS: [9.98, -85.65], MROC: [9.99, -84.21],
    MRPJ: [8.53, -83.30], MRPM: [8.95, -83.47], MRPV: [9.96, -84.14], MRQP: [9.44, -84.13], MRUP: [10.89, -85.02], MSLP: [13.44, -89.06],
    MSSS: [13.70, -89.12], MTCA: [18.27, -73.79], MTCH: [19.73, -72.20], MTF: [64.81, -147.76], MTJA: [18.24, -72.52], MTJE: [18.66, -74.17],
    MTPP: [18.58, -72.29], MTPX: [19.93, -72.85], MUBA: [20.37, -74.51], MUBY: [20.40, -76.62], MUCA: [22.03, -78.79], MUCC: [22.46, -78.33],
    MUCF: [22.15, -80.41], MUCL: [21.62, -81.55], MUCM: [21.42, -77.85], MUCU: [19.97, -75.84], MUGM: [19.91, -75.21], MUGT: [20.09, -75.16],
    MUHA: [22.99, -82.41], MUHG: [20.79, -76.32], MUKW: [23.12, -81.30], MUMO: [20.65, -74.92], MUMZ: [20.29, -77.09], MUNB: [22.76, -81.92],
    MUNG: [21.83, -82.78], MUPB: [23.03, -82.58], MUSC: [22.49, -79.94], MUSJ: [22.10, -84.16], MUSN: [21.64, -82.96], MUTD: [21.79, -80.00],
    MUVR: [23.03, -81.44], MUVT: [20.99, -76.94], MWCB: [19.69, -79.88], MWCL: [19.66, -80.09], MWCR: [19.29, -81.36], MXC: [37.93, -109.34],
    MYAB: [24.29, -77.68], MYAF: [24.70, -77.80], MYAK: [24.16, -77.59], MYAM: [26.51, -77.08], MYAN: [25.05, -78.05], MYAP: [22.44, -73.97],
    MYAT: [26.75, -77.39], MYBC: [25.42, -77.88], MYBG: [25.74, -77.84], MYBS: [25.70, -79.26], MYCA: [24.63, -75.67], MYCB: [24.32, -75.45],
    MYCI: [22.75, -74.18], MYEF: [23.56, -75.88], MYEH: [25.48, -76.68], MYEM: [25.28, -76.33], MYEN: [24.59, -76.82], MYER: [24.89, -76.18],
    MYES: [24.17, -76.44], MYGF: [26.56, -78.70], MYIG: [20.98, -73.67], MYLD: [23.18, -75.09], MYLR: [23.01, -74.90], MYLS: [23.58, -75.27],
    MYMM: [22.38, -73.01], MYNN: [25.04, -77.47], MYRD: [22.18, -75.73], MYSM: [24.06, -74.52], MZBE: [17.52, -88.20], MZBZ: [17.54, -88.30],
    MZCK: [17.74, -88.03], MZCP: [17.68, -88.04], MZCZ: [18.38, -88.41], MZPB: [16.98, -88.23], MZPL: [16.54, -88.36], MZSJ: [18.36, -88.13],
    MZSP: [17.91, -87.97], N23: [42.30, -75.42], NCRG: [-21.20, -159.81], NE69: [40.87, -96.11], NFFN: [-17.76, 177.44], NFNA: [-18.04, 178.56],
    NFTF: [-21.24, -175.15], NFTV: [-18.59, -173.96], NGTA: [1.38, 173.15], NIN: [60.02, -151.59], NLWW: [-13.24, -176.20], NM83: [32.77, -103.21],
    NSFA: [-13.83, -172.01], NSTU: [-14.33, -170.71], NTAA: [-17.55, -149.61], NV11: [36.93, -116.01], NVVV: [-17.70, 168.32], NWWW: [-22.01, 166.21],
    NZAA: [-37.01, 174.79], NZCH: [-43.49, 172.53], NZQN: [-45.02, 168.75], NZWN: [-41.33, 174.81], O19: [40.72, -123.93], O22: [38.03, -120.42],
    O27: [37.76, -120.80], O43: [39.00, -119.16], O85: [40.57, -122.41], OAHR: [34.21, 62.23], OAKB: [34.57, 69.21], OAKN: [31.51, 65.85],
    OAMS: [36.70, 67.21], OBBI: [26.27, 50.64], OEAB: [18.24, 42.66], OEAH: [25.29, 49.49], OEAO: [26.48, 38.12], OEDF: [26.47, 49.80],
    OEDR: [26.27, 50.15], OEGS: [26.30, 43.77], OEHL: [27.44, 41.69], OEJN: [21.68, 39.16], OEMA: [24.55, 39.71], OENN: [27.92, 35.29],
    OEPA: [28.34, 46.13], OERK: [24.96, 46.70], OERS: [25.63, 37.09], OESK: [29.78, 40.10], OETB: [28.37, 36.62], OETF: [21.48, 40.54],
    OEYN: [24.14, 38.06], OIAA: [30.37, 48.23], OIAW: [31.34, 48.76], OIBK: [26.53, 53.98], OIFM: [32.76, 51.88], OIIE: [35.42, 51.15],
    OIII: [35.69, 51.31], OIIP: [35.78, 50.83], OIKB: [27.22, 56.38], OIKK: [30.27, 56.95], OIKQ: [26.75, 55.90], OIMB: [32.90, 59.28],
    OIMM: [36.23, 59.64], OISS: [29.54, 52.59], OITT: [38.13, 46.24], OIZH: [29.48, 60.91], OJAI: [31.72, 35.99], OJAM: [31.97, 35.99],
    OJAQ: [29.61, 35.02], OKKK: [29.22, 47.97], OLBA: [33.82, 35.49], OLH: [57.22, -153.27], OMAA: [24.44, 54.65], OMAD: [24.43, 54.46],
    OMAL: [24.26, 55.61], OMDB: [25.25, 55.37], OMDW: [24.90, 55.16], OMFJ: [25.11, 56.33], OMRK: [25.61, 55.94], OMSJ: [25.33, 55.52],
    OODQ: [19.50, 57.63], OOMS: [23.60, 58.29], OOSA: [17.04, 54.09], OOSH: [24.39, 56.63], OPFA: [31.36, 73.00], OPGW: [25.30, 62.50],
    OPIS: [33.55, 72.83], OPKC: [24.91, 67.16], OPLA: [31.52, 74.40], OPMT: [30.20, 71.42], OPPS: [33.99, 71.51], OPQT: [30.25, 66.94],
    OPSD: [35.34, 75.54], OPST: [32.54, 74.36], OPTU: [25.98, 63.03], ORBI: [33.26, 44.23], ORBM: [36.31, 43.15], ORER: [36.24, 43.95],
    ORI: [57.88, -152.85], ORKK: [35.47, 44.35], ORMM: [30.55, 47.66], ORNI: [31.99, 44.41], OSAP: [36.18, 37.23], OSDI: [33.41, 36.52],
    OTBD: [25.26, 51.57], OTHH: [25.27, 51.61], OYAA: [12.83, 45.03], OYRN: [14.66, 49.38], OYSN: [15.48, 44.22], OYSY: [15.97, 48.79],
    P04: [31.36, -109.88], P10: [35.79, -110.42], P14: [34.94, -110.14], PAAK: [52.22, -174.21], PAAL: [56.01, -160.56], PAAQ: [61.59, -149.09],
    PAAT: [52.83, 173.17], PABA: [70.13, -143.58], PABE: [60.78, -161.84], PABG: [61.17, -151.04], PABI: [63.99, -145.72], PABL: [65.98, -161.15],
    PABM: [59.36, -155.26], PABR: [71.29, -156.77], PABT: [66.91, -151.53], PABV: [61.42, -149.51], PACD: [55.21, -162.73], PACE: [65.57, -144.78],
    PACH: [61.58, -159.22], PACI: [66.64, -143.74], PACJ: [61.87, -158.14], PACK: [60.14, -164.28], PACL: [64.30, -149.12], PACM: [61.84, -165.58],
    PACR: [65.83, -144.08], PACS: [54.58, -164.91], PACV: [60.49, -145.48], PACX: [67.25, -150.20], PACY: [60.08, -142.49], PACZ: [61.78, -166.04],
    PADE: [66.07, -162.77], PADG: [68.03, -162.90], PADK: [51.88, -176.64], PADL: [59.04, -158.51], PADM: [61.86, -162.03], PADQ: [57.75, -152.49],
    PADU: [53.90, -166.54], PADY: [59.96, -162.88], PAED: [61.25, -149.81], PAEE: [60.21, -162.04], PAEG: [64.78, -141.15], PAEH: [58.65, -162.06],
    PAEI: [64.67, -147.10], PAEM: [62.79, -164.49], PAEN: [60.57, -151.25], PAEW: [60.81, -164.50], PAFA: [64.82, -147.86], PAFB: [64.84, -147.61],
    PAFE: [56.96, -133.91], PAFM: [67.11, -157.86], PAFR: [61.27, -149.65], PAFS: [63.02, -154.36], PAGA: [64.74, -156.94], PAGB: [68.48, -149.49],
    PAGG: [59.88, -163.17], PAGH: [66.89, -157.16], PAGK: [62.16, -145.45], PAGL: [64.55, -163.01], PAGM: [63.77, -171.73], PAGQ: [61.53, -149.81],
    PAGS: [58.43, -135.71], PAGT: [60.47, -164.70], PAGX: [62.90, -160.07], PAGY: [59.46, -135.32], PAGZ: [65.40, -161.28], PAHC: [62.19, -159.77],
    PAHL: [65.70, -156.35], PAHN: [59.24, -135.52], PAHO: [59.64, -151.48], PAHP: [61.52, -166.15], PAHU: [66.04, -154.26], PAHX: [62.69, -159.57],
    PAIG: [59.32, -155.90], PAII: [58.18, -157.37], PAIK: [66.98, -160.44], PAIL: [59.75, -154.91], PAIM: [65.99, -153.70], PAIN: [63.73, -148.91],
    PAIW: [65.62, -168.09], PAJC: [56.31, -158.37], PAJN: [58.35, -134.57], PAJZ: [59.73, -157.26], PAKA: [60.87, -146.69], PAKD: [57.81, -152.37],
    PAKF: [54.85, -163.41], PAKH: [56.94, -154.18], PAKI: [59.93, -164.03], PAKK: [64.94, -161.15], PAKL: [58.98, -155.12], PAKN: [58.68, -156.65],
    PAKO: [52.94, -168.85], PAKP: [68.13, -151.74], PAKT: [55.36, -131.71], PAKU: [70.33, -149.60], PAKV: [64.32, -158.74], PAKW: [55.58, -133.08],
    PAKY: [57.57, -154.45], PALB: [57.54, -153.98], PALG: [61.54, -160.34], PALJ: [60.20, -154.33], PALN: [70.91, -153.24], PALR: [67.50, -148.48],
    PALT: [61.09, -160.92], PALU: [68.88, -166.11], PAMB: [58.93, -158.90], PAMC: [62.95, -155.61], PAMD: [59.45, -146.31], PAMH: [63.89, -152.30],
    PAMK: [63.49, -162.11], PAML: [64.99, -150.64], PAMO: [62.10, -163.68], PAMR: [61.21, -149.84], PAMX: [61.44, -142.90], PAMY: [60.37, -166.27],
    PANA: [60.69, -161.98], PANC: [61.18, -149.99], PANI: [61.58, -159.54], PANN: [64.55, -149.07], PANO: [59.98, -154.84], PANT: [55.04, -131.57],
    PANU: [64.73, -158.07], PANV: [62.65, -160.19], PANW: [59.45, -157.37], PAOB: [66.91, -156.90], PAOC: [58.91, -157.71], PAOH: [58.10, -135.41],
    PAOM: [64.51, -165.45], PAOO: [60.54, -165.09], PAOR: [62.96, -141.93], PAOT: [66.88, -162.60], PAOU: [56.01, -161.16], PAPB: [56.58, -169.66],
    PAPC: [65.25, -166.86], PAPE: [55.91, -159.16], PAPG: [56.80, -132.95], PAPH: [56.96, -158.63], PAPK: [60.70, -161.78], PAPM: [59.02, -161.83],
    PAPN: [57.58, -157.57], PAPO: [68.35, -166.80], PAPR: [66.81, -150.64], PAQH: [59.76, -161.84], PAQT: [70.21, -151.01], PARC: [68.11, -145.58],
    PARS: [61.78, -161.32], PARY: [64.73, -155.47], PASA: [63.69, -170.49], PASC: [70.19, -148.46], PASD: [55.31, -160.52], PASH: [66.25, -166.09],
    PASI: [57.05, -135.36], PASK: [66.60, -159.99], PASL: [61.70, -157.17], PASM: [62.06, -163.30], PASN: [57.17, -170.22], PASO: [59.44, -151.71],
    PASP: [61.81, -147.51], PAST: [63.33, -149.13], PASV: [61.10, -155.57], PASW: [61.97, -151.19], PASX: [60.47, -151.04], PASY: [52.71, 174.11],
    PATA: [65.17, -152.11], PATC: [65.56, -167.92], PATE: [65.24, -166.34], PATG: [59.05, -160.40], PATK: [62.32, -150.09], PATL: [62.89, -155.98],
    PATQ: [70.47, -157.44], PAUK: [62.68, -164.72], PAUM: [69.37, -152.14], PAUN: [63.89, -160.80], PAUO: [61.75, -150.05], PAUT: [54.14, -165.60],
    PAVA: [61.54, -165.60], PAVC: [55.12, -162.27], PAVD: [61.13, -146.25], PAVE: [67.01, -146.37], PAVL: [67.73, -164.56], PAWB: [66.36, -147.41],
    PAWD: [60.13, -149.42], PAWG: [56.48, -132.37], PAWI: [70.64, -159.99], PAWM: [64.69, -163.41], PAWN: [67.56, -162.98], PAWS: [61.57, -149.54],
    PAYA: [59.51, -139.66], PFAK: [60.90, -161.23], PFAL: [66.55, -152.62], PFCB: [60.08, -147.99], PFCL: [58.83, -158.53], PFEL: [64.61, -162.27],
    PFKA: [60.87, -162.52], PFKK: [59.43, -154.80], PFKO: [63.03, -163.53], PFKT: [65.33, -166.47], PFKU: [64.88, -157.73], PFKW: [60.79, -161.44],
    PFMP: [65.51, -150.14], PFNO: [66.82, -161.02], PFSH: [64.37, -161.22], PFSV: [66.02, -149.06], PFTO: [63.33, -142.95], PFWS: [58.70, -157.01],
    PFYU: [66.57, -145.25], PFZK: [60.91, -161.49], PGM: [59.35, -151.83], PGRO: [14.17, 145.24], PGUM: [13.48, 144.80], PHBK: [22.02, -159.79],
    PHDH: [21.58, -158.20], PHHI: [21.48, -158.04], PHHN: [20.80, -156.01], PHIK: [21.34, -157.95], PHJH: [20.96, -156.67], PHJR: [21.31, -158.07],
    PHKO: [19.74, -156.05], PHLI: [21.97, -159.34], PHLU: [21.21, -156.97], PHMK: [21.15, -157.10], PHMU: [20.00, -155.67], PHNG: [21.45, -157.77],
    PHNL: [21.32, -157.93], PHNY: [20.79, -156.95], PHOG: [20.90, -156.43], PHPA: [21.90, -159.60], PHSF: [19.76, -155.55], PHTO: [19.72, -155.05],
    PHUP: [20.27, -155.86], PKMJ: [7.07, 171.27], PLCH: [1.99, -157.35], PODC: [66.94, -156.90], POKA: [60.57, -165.25], PPCT: [62.99, -156.03],
    PPIT: [60.91, -162.44], PPIZ: [69.73, -163.01], PTKK: [7.46, 151.84], PTRO: [7.37, 134.54], PTSA: [5.36, 162.96], PTYA: [9.50, 138.08],
    RCKH: [22.58, 120.35], RCMQ: [24.26, 120.62], RCNN: [22.95, 120.21], RCQC: [23.57, 119.63], RCSS: [25.07, 121.55], RCTP: [25.08, 121.23],
    RCYU: [24.02, 121.62], RDV: [61.79, -157.35], RJAA: [35.77, 140.39], RJAH: [36.18, 140.41], RJBB: [34.43, 135.24], RJBE: [34.63, 135.22],
    RJCC: [42.77, 141.69], RJCH: [41.77, 140.82], RJFF: [33.59, 130.45], RJFK: [31.80, 130.72], RJFM: [31.88, 131.45], RJFR: [33.85, 131.04],
    RJFS: [33.15, 130.30], RJFT: [32.84, 130.85], RJFU: [32.92, 129.91], RJGG: [34.86, 136.80], RJNK: [36.39, 136.41], RJNS: [34.80, 138.19],
    RJOA: [34.44, 132.92], RJOB: [34.76, 133.85], RJOK: [33.55, 133.67], RJOM: [33.83, 132.70], RJOO: [34.78, 135.44], RJOS: [34.13, 134.61],
    RJOT: [34.21, 134.02], RJSA: [40.73, 140.69], RJSN: [37.95, 139.11], RJSS: [38.14, 140.92], RJTT: [35.55, 139.79], RKJB: [34.99, 126.38],
    RKNY: [38.06, 128.67], RKPC: [33.51, 126.49], RKPK: [35.18, 128.94], RKSI: [37.47, 126.45], RKSS: [37.56, 126.79], RKTN: [35.89, 128.66],
    RKTU: [36.72, 127.50], ROAH: [26.19, 127.64], RODN: [26.35, 127.77], RPLB: [14.79, 120.27], RPLC: [15.19, 120.56], RPLI: [18.18, 120.53],
    RPLK: [13.11, 123.68], RPLL: [14.51, 121.02], RPMD: [7.13, 125.65], RPMR: [6.06, 125.10], RPMY: [8.61, 124.46], RPMZ: [6.92, 122.06],
    RPSP: [9.57, 123.77], RPVB: [10.78, 123.02], RPVI: [10.83, 122.49], RPVK: [11.68, 122.38], RPVM: [10.31, 123.98], RPVP: [9.74, 118.76],
    S05: [43.09, -124.41], S31: [48.48, -122.94], S39: [44.29, -120.90], SAAR: [-32.90, -60.78], SABE: [-34.56, -58.42], SACO: [-31.31, -64.21],
    SAEZ: [-34.82, -58.54], SAME: [-32.83, -68.79], SANT: [-26.84, -65.10], SARE: [-27.45, -59.06], SASA: [-24.86, -65.49], SASJ: [-24.39, -65.10],
    SAVC: [-45.79, -67.46], SAWG: [-51.61, -69.31], SAZN: [-38.95, -68.16], SAZS: [-41.15, -71.16], SBBE: [-1.38, -48.48], SBBR: [-15.87, -47.92],
    SBBV: [2.85, -60.69], SBCF: [-19.64, -43.97], SBCT: [-25.53, -49.18], SBCY: [-15.65, -56.12], SBEG: [-3.04, -60.05], SBFI: [-25.59, -54.49],
    SBFL: [-27.67, -48.55], SBFZ: [-3.78, -38.53], SBGL: [-22.81, -43.25], SBGO: [-16.63, -49.22], SBGR: [-23.43, -46.47], SBJP: [-7.15, -34.95],
    SBKP: [-23.01, -47.13], SBMO: [-9.51, -35.79], SBNF: [-26.88, -48.65], SBPA: [-29.99, -51.17], SBPS: [-16.44, -39.08], SBPV: [-8.71, -63.90],
    SBRB: [-9.87, -67.89], SBRF: [-8.13, -34.92], SBRJ: [-22.91, -43.16], SBSG: [-5.77, -35.37], SBSL: [-2.59, -44.24], SBSP: [-23.63, -46.65],
    SBSV: [-12.91, -38.32], SBVT: [-20.26, -40.28], SCCI: [-53.00, -70.85], SCDA: [-20.54, -70.18], SCEL: [-33.39, -70.79], SCFA: [-23.45, -70.45],
    SCIE: [-36.77, -73.06], SCIP: [-27.17, -109.42], SCQP: [-38.93, -72.65], SCTE: [-41.44, -73.09], SEGU: [-2.16, -79.88], SEQM: [-0.13, -78.35],
    SESA: [-2.21, -80.99], SETN: [0.98, -79.63], SGAS: [-25.24, -57.52], SGEN: [-27.23, -55.84], SGES: [-25.46, -54.84], SKBO: [4.70, -74.15],
    SKBQ: [10.89, -74.78], SKCG: [10.44, -75.51], SKCL: [3.54, -76.38], SKRG: [6.16, -75.42], SKSP: [12.58, -81.71], SLAL: [-19.25, -65.15],
    SLCB: [-17.42, -66.18], SLLP: [-16.51, -68.19], SLOR: [-17.96, -67.08], SLUY: [-20.44, -66.86], SLVR: [-17.64, -63.14], SMJP: [5.45, -55.19],
    SOCA: [4.82, -52.36], SPCL: [-8.38, -74.57], SPHI: [-6.79, -79.83], SPJC: [-12.02, -77.11], SPJL: [-15.47, -70.16], SPQT: [-3.78, -73.31],
    SPQU: [-16.34, -71.57], SPRU: [-8.08, -79.11], SPSO: [-13.74, -76.22], SPZO: [-13.54, -71.94], SRV: [61.79, -156.59], SUMU: [-34.84, -56.03],
    SVBC: [10.11, -64.69], SVBM: [10.04, -69.36], SVMC: [10.56, -71.73], SVMG: [10.91, -63.97], SVMI: [10.60, -66.99], SVPR: [8.29, -62.76],
    SVVA: [10.15, -67.93], SXP: [62.52, -164.85], SYCJ: [6.50, -58.25], TAPA: [17.14, -61.79], TAPB: [17.62, -61.80], TBPB: [13.07, -59.49],
    TDCF: [15.34, -61.39], TDPD: [15.55, -61.30], TFFF: [14.59, -61.00], TFFR: [16.27, -61.53], TGPY: [12.00, -61.79], TIST: [18.34, -64.98],
    TISX: [17.70, -64.80], TJAB: [18.45, -66.68], TJBQ: [18.49, -67.13], TJCP: [18.31, -65.30], TJIG: [18.46, -66.10], TJMZ: [18.26, -67.15],
    TJPS: [18.01, -66.56], TJRV: [18.25, -65.64], TJSJ: [18.44, -66.00], TJVQ: [18.13, -65.49], TKPK: [17.31, -62.72], TKPN: [17.21, -62.59],
    TLPC: [14.02, -60.99], TLPL: [13.73, -60.95], TNCA: [12.50, -70.01], TNCB: [12.13, -68.27], TNCC: [12.19, -68.96], TNCM: [18.04, -63.11],
    TQPF: [18.20, -63.05], TRPG: [16.79, -62.19], TSG: [63.37, -143.34], TTCP: [11.15, -60.83], TTPP: [10.60, -61.34], TUPJ: [18.45, -64.54],
    TUPW: [18.45, -64.43], TVSA: [13.16, -61.15], TVSB: [12.99, -61.26], TVSC: [12.70, -61.34], TVSM: [12.89, -61.18], TVSU: [12.60, -61.41],
    TXKF: [32.36, -64.68], TYE: [61.08, -151.13], U55: [37.85, -112.39], UAAA: [43.35, 77.04], UACC: [51.03, 71.47], UACK: [53.33, 69.59],
    UACP: [54.78, 69.19], UADD: [42.85, 71.30], UAII: [42.37, 69.48], UAIT: [43.31, 68.55], UAKD: [47.71, 67.74], UAKK: [49.67, 73.33],
    UAOL: [45.62, 63.21], UAOO: [44.71, 65.59], UARR: [51.15, 51.54], UASK: [50.04, 82.50], UASP: [52.19, 77.07], UASS: [50.35, 80.23],
    UATE: [43.86, 51.09], UATG: [47.12, 51.82], UATT: [50.25, 57.20], UAUU: [53.21, 63.55], UBBB: [40.47, 50.05], UBBG: [40.74, 46.32],
    UBBN: [39.19, 45.46], UCFL: [42.59, 76.70], UCFM: [43.06, 74.48], UCFO: [40.61, 72.79], UDSG: [40.75, 43.86], UDYZ: [40.15, 44.40],
    UEEE: [62.09, 129.77], UGB: [57.42, -157.74], UGKO: [42.18, 42.49], UGSB: [41.61, 41.60], UGTB: [41.67, 44.95], UHPP: [53.17, 158.45],
    UHSS: [46.89, 142.72], UHWW: [43.40, 132.15], UIAA: [52.02, 113.31], UIII: [52.27, 104.40], UIUU: [51.81, 107.44], UKBB: [50.35, 30.89],
    UKFF: [45.05, 33.98], UKLL: [49.81, 23.96], ULLI: [59.80, 30.26], ULMM: [68.78, 32.75], UMBB: [52.11, 23.90], UMKK: [54.89, 20.60],
    UMMS: [53.89, 28.04], UNAA: [53.74, 91.39], UNBB: [53.36, 83.54], UNEE: [55.27, 86.11], UNKL: [56.18, 92.49], UNNT: [55.02, 82.62],
    UNOO: [54.96, 73.31], UNTT: [56.38, 85.21], UOOO: [69.31, 87.33], URKK: [45.03, 39.17], URMG: [43.39, 45.70], URML: [42.82, 47.65],
    URMM: [44.23, 43.08], URRP: [47.49, 39.92], URSS: [43.45, 39.96], URWA: [46.28, 48.01], URWW: [48.78, 44.34], USCC: [55.30, 61.50],
    USCM: [53.39, 58.76], USNN: [60.95, 76.48], USPP: [57.91, 56.02], USRR: [61.34, 73.41], USSS: [56.74, 60.80], USTR: [57.18, 65.33],
    UT25: [37.02, -110.20], UTAA: [37.99, 58.36], UTAT: [41.76, 59.84], UTAV: [38.93, 63.56], UTDD: [38.54, 68.82], UTDK: [37.99, 69.81],
    UTDL: [40.22, 69.69], UTDT: [37.87, 68.86], UUBW: [55.55, 38.15], UUDD: [55.41, 37.91], UUDL: [57.56, 40.16], UUEE: [55.98, 37.41],
    UUWW: [55.59, 37.26], UWGG: [56.23, 43.79], UWKD: [55.61, 49.28], UWPS: [54.13, 45.21], UWSG: [51.71, 46.17], UWUU: [54.56, 55.87],
    UWWW: [53.50, 50.16], UZFN: [40.98, 71.56], UZNN: [42.49, 59.62], UZNU: [41.58, 60.64], UZSB: [39.78, 64.48], UZSS: [39.70, 66.98],
    UZTT: [41.26, 69.28], VAAH: [23.08, 72.63], VABB: [19.09, 72.87], VABO: [22.34, 73.23], VABP: [23.29, 77.34], VAHS: [22.38, 71.04],
    VAID: [22.72, 75.80], VANM: [18.98, 73.07], VANP: [21.09, 79.05], VAOZ: [20.12, 73.91], VAPO: [18.58, 73.92], VASD: [19.69, 74.37],
    VASU: [21.12, 72.74], VCBI: [7.18, 79.88], VCCC: [6.82, 79.89], VCCJ: [9.79, 80.07], VDDS: [10.91, 103.23], VDPP: [11.55, 104.84],
    VDSA: [13.37, 104.22], VDSV: [10.57, 103.63], VDTI: [11.36, 104.92], VEBD: [26.68, 88.33], VEBN: [25.45, 82.86], VEBS: [20.25, 85.81],
    VECC: [22.65, 88.45], VEGT: [26.11, 91.59], VEIM: [24.76, 93.90], VGEG: [22.25, 91.81], VGHS: [23.84, 90.40], VGSY: [24.96, 91.86],
    VHHH: [22.31, 113.91], VIAR: [31.71, 74.80], VICG: [30.67, 76.79], VIDP: [28.56, 77.10], VIHR: [29.19, 75.74], VIHX: [30.75, 75.63],
    VIJP: [26.82, 75.81], VILK: [26.76, 80.89], VIND: [28.18, 77.61], VISR: [33.99, 74.77], VLLB: [19.90, 102.17], VLPS: [15.13, 105.78],
    VLVT: [17.99, 102.57], VMMC: [22.15, 113.59], VNBW: [27.50, 83.41], VNKT: [27.70, 85.36], VNPR: [28.18, 84.01], VOBL: [13.20, 77.71],
    VOBZ: [16.53, 80.80], VOCB: [11.03, 77.04], VOCI: [10.15, 76.40], VOCL: [11.14, 75.96], VOGA: [15.74, 73.86], VOGO: [15.38, 73.83],
    VOHS: [17.23, 78.43], VOKN: [11.92, 75.54], VOML: [12.95, 74.89], VOMM: [12.99, 80.17], VOPB: [11.64, 92.73], VOTP: [13.63, 79.54],
    VOTR: [10.76, 78.72], VOTV: [8.48, 76.92], VOVI: [17.97, 83.50], VQPR: [27.40, 89.42], VRMG: [-0.69, 73.15], VRMH: [6.74, 73.17],
    VRMM: [4.19, 73.53], VTBD: [13.91, 100.61], VTBS: [13.68, 100.75], VTBU: [12.68, 101.00], VTCC: [18.77, 98.96], VTCT: [19.95, 99.88],
    VTSG: [8.10, 98.99], VTSM: [9.55, 100.06], VTSP: [8.11, 98.32], VTSS: [6.93, 100.39], VTUD: [17.39, 102.79], VVCI: [20.82, 106.72],
    VVCR: [12.00, 109.22], VVCT: [10.08, 105.71], VVDN: [16.04, 108.20], VVLT: [10.77, 107.04], VVNB: [21.22, 105.81], VVPQ: [10.17, 103.99],
    VVTS: [10.82, 106.65], VYMD: [21.70, 95.98], VYNT: [19.62, 96.20], VYYY: [16.91, 96.13], W28: [48.10, -123.19], W99: [38.99, -79.15],
    WA09: [48.61, -123.14], WAAA: [-5.08, 119.55], WADD: [-8.75, 115.17], WADL: [-8.76, 116.28], WAHI: [-7.91, 110.06], WAHQ: [-7.52, 110.76],
    WAHS: [-6.97, 110.37], WAJJ: [-2.58, 140.52], WALL: [-1.27, 116.89], WAMM: [1.55, 124.93], WAOO: [-3.44, 114.76], WAPP: [-3.71, 128.09],
    WARR: [-7.38, 112.79], WBB: [63.52, -162.28], WBGG: [1.49, 110.35], WBKK: [5.93, 116.05], WBSB: [4.94, 114.93], WIDD: [1.12, 104.12],
    WIEE: [-0.79, 100.28], WIHH: [-6.27, 106.89], WIII: [-6.13, 106.66], WIMM: [3.64, 98.87], WIOO: [-0.15, 109.40], WITT: [5.53, 95.42],
    WMKI: [4.57, 101.09], WMKJ: [1.64, 103.67], WMKK: [2.75, 101.71], WMKL: [6.33, 99.73], WMKP: [5.30, 100.28], WMSA: [3.13, 101.55],
    WN07: [48.50, -122.81], WPDL: [-8.55, 125.52], WPOC: [-9.20, 124.34], WSM: [67.40, -150.12], WSSS: [1.35, 103.99], WV66: [39.95, -80.76],
    X39: [28.22, -82.37], Y01: [43.28, -91.47], YBBN: [-27.38, 153.12], YBCG: [-28.17, 153.51], YBCS: [-16.88, 145.75], YBRM: [-17.95, 122.23],
    YBSU: [-26.59, 153.08], YBWW: [-27.56, 151.79], YMAV: [-38.04, 144.47], YMHB: [-42.84, 147.51], YMML: [-37.67, 144.84], YPAD: [-34.95, 138.53],
    YPCC: [-12.19, 96.83], YPDN: [-12.41, 130.88], YPPD: [-20.38, 118.63], YPPH: [-31.94, 115.97], YSSY: [-33.95, 151.18], YSWS: [-33.88, 150.71],
    YWLM: [-32.80, 151.84], Z48: [63.57, -156.15], Z91: [66.27, -145.82], Z93: [61.94, -145.30], ZBAA: [40.08, 116.60], ZBAD: [39.50, 116.41],
    ZBDS: [39.49, 109.86], ZBDT: [40.06, 113.48], ZBHH: [40.85, 111.82], ZBLA: [49.21, 119.82], ZBOW: [40.56, 110.00], ZBSJ: [38.28, 114.70],
    ZBTJ: [39.12, 117.35], ZBYC: [35.12, 111.03], ZBYN: [37.75, 112.63], ZGDY: [29.10, 110.44], ZGGG: [23.39, 113.30], ZGHA: [28.19, 113.22],
    ZGKL: [25.22, 110.04], ZGNN: [22.60, 108.18], ZGOW: [23.55, 116.50], ZGSD: [22.01, 113.38], ZGSZ: [22.64, 113.80], ZGZJ: [21.48, 110.59],
    ZHCC: [34.53, 113.85], ZHEC: [30.34, 115.04], ZHHH: [30.77, 114.21], ZHLY: [34.74, 112.39], ZJHK: [19.93, 110.46], ZJSY: [18.30, 109.41],
    ZKPY: [39.22, 125.67], ZLDH: [40.16, 94.81], ZLIC: [38.32, 106.39], ZLJQ: [39.86, 98.34], ZLLL: [36.52, 103.62], ZLXN: [36.53, 102.04],
    ZLXY: [34.44, 108.76], ZMCK: [47.65, 106.82], ZMUB: [47.84, 106.77], ZNC: [60.98, -159.99], ZPJH: [21.97, 100.76], ZPLJ: [26.68, 100.24],
    ZPPP: [25.11, 102.94], ZSAM: [24.54, 118.13], ZSCN: [28.86, 115.90], ZSFZ: [25.93, 119.67], ZSHC: [30.24, 120.43], ZSJN: [36.86, 117.22],
    ZSLG: [34.41, 119.18], ZSNB: [29.83, 121.46], ZSNJ: [31.74, 118.87], ZSOF: [31.99, 116.98], ZSPD: [31.14, 121.81], ZSQD: [36.36, 120.09],
    ZSQZ: [24.80, 118.59], ZSSH: [33.79, 119.13], ZSSS: [31.20, 121.33], ZSTX: [29.73, 118.26], ZSWX: [31.50, 120.43], ZSWZ: [27.91, 120.85],
    ZSYN: [33.43, 120.21], ZSYT: [37.66, 120.98], ZSYW: [29.34, 120.03], ZSZS: [29.93, 122.36], ZUCK: [29.71, 106.65], ZUGY: [26.54, 106.80],
    ZULS: [29.30, 90.91], ZURK: [29.35, 89.30], ZUTF: [30.31, 104.44], ZUUU: [30.56, 103.95], ZWSH: [39.54, 76.02], ZWWW: [43.91, 87.48],
    ZYCC: [44.00, 125.68], ZYHB: [45.62, 126.25], ZYQQ: [47.23, 123.91], ZYTL: [38.97, 121.54], ZYTX: [41.64, 123.48],
  };

  function coordsFor(code) {
    const n = normAirport(code);
    if (!n) return null;
    return AIRPORT_COORDS[n] || (n.length === 3 ? AIRPORT_COORDS["K" + n] : null) || null;
  }

  // Great-circle distance in nautical miles.
  function airportNM(a, b) {
    const ca = coordsFor(a), cb = coordsFor(b);
    if (!ca || !cb) return null;
    const rad = Math.PI / 180;
    const dLat = (cb[0] - ca[0]) * rad, dLon = (cb[1] - ca[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(ca[0] * rad) * Math.cos(cb[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 3440.065 * Math.asin(Math.sqrt(h));
  }

  // Year's flying per tail: exact great-circle where both fields are known,
  // hours x cruise speed otherwise, and an honest count of legs it couldn't
  // measure at all. speeds maps normalized tail -> cruise knots.
  function yearlyMiles(legs, year, speeds) {
    speeds = speeds || {};
    const by = {};
    for (const leg of legs) {
      if (!leg.date || !leg.tail || leg.date.slice(0, 4) !== String(year)) continue;
      const t = normTail(leg.tail);
      if (!by[t]) by[t] = { tail: t, nm: 0, legs: 0, estimated: 0, skipped: 0 };
      const b = by[t];
      const d = airportNM(leg.from, leg.to);
      if (d !== null && d > 0) { b.nm += d; b.legs++; }
      else if (typeof leg.hours === "number" && leg.hours > 0 && speeds[t] > 0) {
        b.nm += leg.hours * speeds[t]; b.legs++; b.estimated++;
      } else { b.skipped++; }
    }
    return Object.keys(by).sort().map((t) => ({ ...by[t], nm: Math.round(by[t].nm) }));
  }

  // ---------- per-family bills ----------

  // Group a statement's lines into one itemized bill per family.
  function familyBills(statement) {
    const by = {};
    for (const l of statement.lines) {
      if (!by[l.family]) by[l.family] = [];
      by[l.family].push(l);
    }
    return Object.keys(by).sort().map((name) => {
      const lines = by[name];
      return {
        family: name,
        lines: lines,
        total: lines.reduce((s, l) => s + l.total, 0),
        gallons: lines.reduce((s, l) => s + l.gallons, 0),
      };
    });
  }

  // Plain-text rendering for an email or text message body.
  function familyBillText(bill, period) {
    const rows = bill.lines.map((l) =>
      l.date + "  " + l.tail + "  " + (l.airport || "—") +
      (l.gallons ? "  " + l.gallons + " gal" : "") +
      "  $" + l.total.toFixed(2) +
      (l.invoiceNumber ? "  (inv " + l.invoiceNumber + ")" : ""));
    return "FUEL BILL — " + bill.family + "\n" +
      "Period: " + (period || "all dates") + "\n" +
      "―――――――――――――――――――――――\n" +
      rows.join("\n") + "\n" +
      "―――――――――――――――――――――――\n" +
      "TOTAL DUE: $" + bill.total.toFixed(2) + "  (" + Math.round(bill.gallons) + " gal)\n";
  }

  function familyBillCSV(bill) {
    const esc = (v) => {
      v = String(v == null ? "" : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const rows = [["Date", "Tail", "Airport", "Gallons", "Amount", "Invoice #"]];
    for (const l of bill.lines) rows.push([l.date, l.tail, l.airport, l.gallons, l.total.toFixed(2), l.invoiceNumber]);
    rows.push([]);
    rows.push(["Total due", "", "", Math.round(bill.gallons), bill.total.toFixed(2), ""]);
    return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
  }

  const FuelMatch = {
    parseCSV, detectColumns, parseDateLoose, parseDuration, normTail, tailsEqual,
    normAirport, airportsEqual, dateDiffDays, extractInvoiceFields,
    matchFuelToLegs, buildStatement, statementCSV, monthlyChecks,
    familyBills, familyBillText, familyBillCSV,
    airportNM, yearlyMiles,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = FuelMatch;
  else global.FuelMatch = FuelMatch;
})(typeof self !== "undefined" ? self : this);
