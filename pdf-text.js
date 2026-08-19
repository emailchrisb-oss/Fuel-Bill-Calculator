// Best-effort in-browser PDF text extraction with zero dependencies.
//
// Most FBO/World Fuel invoices are machine-generated PDFs whose content
// streams are Flate-compressed and use simple (non-CID) fonts, which this
// handles. When a PDF defeats it (scanned image, exotic font encoding) the
// caller gets ok:false and the page falls back to paste-the-text.
(function (global) {
  "use strict";

  const latin1 = new TextDecoder("latin1");

  async function inflate(bytes) {
    for (const format of ["deflate", "deflate-raw"]) {
      try {
        const ds = new DecompressionStream(format);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (e) { /* try the next format */ }
    }
    return null;
  }

  // Pull every stream object out of the file, decompressing FlateDecode ones.
  async function contentStreams(bytes) {
    const raw = latin1.decode(bytes);
    const streams = [];
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw))) {
      const start = m.index + m[0].length;
      const end = raw.indexOf("endstream", start);
      if (end < 0) break;
      // The object's dictionary sits between the previous "obj" and "stream".
      const dictStart = raw.lastIndexOf("obj", m.index);
      const dict = raw.slice(dictStart < 0 ? 0 : dictStart, m.index);
      // Skip obvious non-content streams (fonts, images, metadata).
      if (/\/Subtype\s*\/(?:Image|XML)|\/FontFile/.test(dict)) { re.lastIndex = end; continue; }
      let data = bytes.subarray(start, end);
      // Strip the EOL that precedes "endstream".
      let len = data.length;
      if (len && data[len - 1] === 0x0a) len--;
      if (len && data[len - 1] === 0x0d) len--;
      data = data.subarray(0, len);
      if (/\/FlateDecode/.test(dict)) {
        const out = await inflate(data);
        if (out) streams.push(out);
      } else if (!/\/Filter/.test(dict)) {
        streams.push(data);
      }
      re.lastIndex = end;
    }
    return streams;
  }

  function decodePdfString(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== "\\") { out += c; continue; }
      const n = s[++i];
      if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === "b" || n === "f") out += "";
      else if (n >= "0" && n <= "7") {
        let oct = n;
        while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else out += n; // covers \\, \(, \), and escaped newlines
    }
    return out;
  }

  // Walk a content stream's text operators and emit their strings, inserting
  // newlines on text-position moves so labeled fields stay on their own lines.
  function textFromContent(content) {
    const src = latin1.decode(content);
    let out = "";
    let i = 0;
    const pending = []; // operand strings collected since the last operator
    while (i < src.length) {
      const c = src[i];
      if (c === "(") {
        // literal string — find the balancing paren, honoring escapes
        let depth = 1, j = i + 1, s = "";
        while (j < src.length && depth > 0) {
          const ch = src[j];
          if (ch === "\\") { s += ch + (src[j + 1] || ""); j += 2; continue; }
          if (ch === "(") depth++;
          else if (ch === ")") { depth--; if (!depth) break; }
          if (depth) s += ch;
          j++;
        }
        pending.push(decodePdfString(s));
        i = j + 1;
      } else if (c === "<" && src[i + 1] !== "<") {
        const j = src.indexOf(">", i);
        const hex = src.slice(i + 1, j < 0 ? src.length : j).replace(/[^0-9a-fA-F]/g, "");
        let s = "";
        // Guess byte width: 2-byte codes decode to control chars for simple
        // fonts, so try 1-byte first and keep whichever is more printable.
        let one = "", two = "";
        for (let k = 0; k + 2 <= hex.length; k += 2) one += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
        for (let k = 0; k + 4 <= hex.length; k += 4) two += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
        s = printableRatio(one) >= printableRatio(two) ? one : two;
        pending.push(s);
        i = j < 0 ? src.length : j + 1;
      } else if (/[A-Za-z'"*]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z'"*]/.test(src[j])) j++;
        const op = src.slice(i, j);
        if (op === "Tj" || op === "'" || op === '"') {
          out += pending.join("");
        } else if (op === "TJ") {
          out += pending.join("");
        } else if (op === "Td" || op === "TD" || op === "T*" || op === "BT") {
          out += "\n";
        } else if (op === "Tm") {
          out += "\n";
        }
        pending.length = 0;
        i = j;
      } else {
        i++;
      }
    }
    return out;
  }

  function printableRatio(s) {
    if (!s.length) return 0;
    let ok = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) ok++;
    }
    return ok / s.length;
  }

  // -> {ok, text, reason}
  async function extractPdfText(arrayBuffer) {
    if (typeof DecompressionStream === "undefined") {
      return { ok: false, text: "", reason: "This browser can't decompress PDFs — paste the invoice text instead." };
    }
    const bytes = new Uint8Array(arrayBuffer);
    if (latin1.decode(bytes.subarray(0, 8)).indexOf("%PDF") !== 0) {
      return { ok: false, text: "", reason: "Not a PDF file." };
    }
    let text = "";
    try {
      for (const stream of await contentStreams(bytes)) {
        // Only walk streams that look like page content (contain text ops).
        if (!/\bBT\b|\bTj\b|\bTJ\b/.test(latin1.decode(stream))) continue;
        text += textFromContent(stream) + "\n";
      }
    } catch (e) {
      return { ok: false, text: "", reason: "Couldn't parse this PDF — paste the invoice text instead." };
    }
    const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
    if (!cleaned) {
      return { ok: false, text: "", reason: "No text layer found — this looks like a scan. Type or paste the numbers instead." };
    }
    if (printableRatio(cleaned) < 0.6) {
      return { ok: false, text: "", reason: "This PDF's text is encoded in a way that can't be read here — paste the invoice text instead." };
    }
    return { ok: true, text: cleaned, reason: "" };
  }

  global.extractPdfText = extractPdfText;
})(typeof self !== "undefined" ? self : this);
