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

  // Compact coordinates for fields a Texas-based Lear/CJ group plausibly
  // uses; legs between unknown fields fall back to hours x cruise speed.
  const AIRPORT_COORDS = {
    KAUS: [30.19, -97.67], KDAL: [32.85, -96.85], KDFW: [32.90, -97.04], KADS: [32.97, -96.84],
    KHOU: [29.65, -95.28], KIAH: [29.98, -95.34], KSAT: [29.53, -98.47], KELP: [31.81, -106.38],
    KMAF: [31.94, -102.20], KLBB: [33.66, -101.82], KAMA: [35.22, -101.71], KOKC: [35.39, -97.60],
    KTUL: [36.20, -95.89], KICT: [37.65, -97.43], KMCI: [39.30, -94.71], KSTL: [38.75, -90.37],
    KMEM: [35.04, -89.98], KBNA: [36.12, -86.68], KATL: [33.64, -84.43], KMIA: [25.79, -80.29],
    KFLL: [26.07, -80.15], KPBI: [26.68, -80.10], KMCO: [28.43, -81.31], KTPA: [27.98, -82.53],
    KJAX: [30.49, -81.69], KORD: [41.98, -87.90], KMDW: [41.79, -87.75], KMKE: [42.95, -87.90],
    KMSP: [44.88, -93.22], KOMA: [41.30, -95.89], KDEN: [39.86, -104.67], KAPA: [39.57, -104.85],
    KASE: [39.22, -106.87], KEGE: [39.64, -106.92], KGUC: [38.53, -106.93], KMTJ: [38.51, -107.89],
    KJAC: [43.61, -110.74], KSUN: [43.50, -114.30], KBZN: [45.78, -111.15], KSLC: [40.79, -111.98],
    KLAS: [36.08, -115.15], KHND: [35.97, -115.13], KPHX: [33.43, -112.01], KSDL: [33.62, -111.91],
    KTUS: [32.12, -110.94], KABQ: [35.04, -106.61], KSAF: [35.62, -106.09], KLAX: [33.94, -118.41],
    KVNY: [34.21, -118.49], KBUR: [34.20, -118.36], KSNA: [33.68, -117.87], KSAN: [32.73, -117.19],
    KSFO: [37.62, -122.38], KOAK: [37.72, -122.22], KSJC: [37.36, -121.93], KSEA: [47.45, -122.31],
    KBFI: [47.53, -122.30], KPDX: [45.59, -122.60], KTEB: [40.85, -74.06], KJFK: [40.64, -73.78],
    KLGA: [40.78, -73.87], KEWR: [40.69, -74.17], KHPN: [41.07, -73.71], KBOS: [42.36, -71.01],
    KBED: [42.47, -71.29], KPHL: [39.87, -75.24], KBWI: [39.18, -76.67], KDCA: [38.85, -77.04],
    KIAD: [38.95, -77.46], KCLT: [35.21, -80.94], KRDU: [35.88, -78.79], KSAV: [32.13, -81.20],
    KCHS: [32.90, -80.04], KHXD: [32.22, -80.70], KMSY: [29.99, -90.26], KNEW: [30.04, -90.03],
    KBTR: [30.53, -91.15], KGPT: [30.41, -89.08], KDTW: [42.21, -83.35], KCLE: [41.41, -81.85],
    KPIT: [40.49, -80.23], KCMH: [40.00, -82.89], KIND: [39.72, -86.29], KEYW: [24.56, -81.76],
    KAPF: [26.15, -81.78], KRSW: [26.54, -81.76], KSRQ: [27.40, -82.55], KOPF: [25.91, -80.28],
    KFXE: [26.20, -80.17], KBCT: [26.38, -80.11], KTRK: [39.32, -120.14], KRNO: [39.50, -119.77],
    KHDN: [40.48, -107.22], KRIL: [39.53, -107.73], KTEX: [37.95, -107.90], KDRO: [37.15, -107.75],
    KCOS: [38.81, -104.70], KBJC: [39.91, -105.12], KGJT: [39.12, -108.53], KBOI: [43.56, -116.22],
    KBIL: [45.81, -108.54], KCOD: [44.52, -109.02], KRAP: [44.05, -103.06], KFSD: [43.58, -96.74],
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
