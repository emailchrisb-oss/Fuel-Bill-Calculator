// Tests for the fuel-split logic. Run with: node run_tests.js (or ./run_tests.sh)
"use strict";
const zlib = require("zlib");
const FM = require("../match.js");
const { extractPdfText } = require("../pdf-text.js");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL: " + name); }
}
function eq(name, got, want) {
  check(name + " (got " + JSON.stringify(got) + ", want " + JSON.stringify(want) + ")",
    JSON.stringify(got) === JSON.stringify(want));
}

// ---------- CSV ----------
const csv = 'Date,Aircraft,From,To,"Passenger, Lead"\n06/03/2026,N45XX,KAUS,KASE,"Smith, John"\n\n06/05/2026,N45XX,KASE,KAUS,Jones\n';
const rows = FM.parseCSV(csv);
eq("csv row count", rows.length, 3);
eq("csv quoted header", rows[0][4], "Passenger, Lead");
eq("csv quoted comma field", rows[1][4], "Smith, John");

// ---------- column detection ----------
const cols = FM.detectColumns(["Date", "Aircraft", "From", "To", "Passenger, Lead"]);
eq("detect date", cols.date, 0);
eq("detect tail", cols.tail, 1);
eq("detect from", cols.from, 2);
eq("detect to", cols.to, 3);
eq("detect owner", cols.owner, 4);

const cols2 = FM.detectColumns(["Trip Date", "Dep Time", "Tail Number", "Origin", "Destination", "Client Name", "Pax Count"]);
eq("detect date not time", cols2.date, 0);
eq("detect tail 2", cols2.tail, 2);
eq("detect origin", cols2.from, 3);
eq("detect destination", cols2.to, 4);
eq("detect client not pax count", cols2.owner, 5);

// ---------- dates ----------
eq("date iso", FM.parseDateLoose("2026-06-03"), "2026-06-03");
eq("date us", FM.parseDateLoose("06/03/2026"), "2026-06-03");
eq("date us short year", FM.parseDateLoose("6/3/26"), "2026-06-03");
eq("date dd-mon", FM.parseDateLoose("3-Jun-2026"), "2026-06-03");
eq("date mon dd", FM.parseDateLoose("Jun 3, 2026"), "2026-06-03");
eq("date with time", FM.parseDateLoose("06/03/2026 14:30"), "2026-06-03");
eq("date garbage", FM.parseDateLoose("not a date"), null);
eq("date bad month", FM.parseDateLoose("13/45/2026"), null);

// ---------- normalization ----------
check("tails equal with dash", FM.tailsEqual("N-45XX", "n45xx"));
check("tails not equal", !FM.tailsEqual("N45XX", "N525CJ"));
check("empty tails not equal", !FM.tailsEqual("", ""));
check("airport K-prefix", FM.airportsEqual("KAUS", "AUS"));
check("airport exact", FM.airportsEqual("kase", "KASE"));
check("airport different", !FM.airportsEqual("KAUS", "KDAL"));
eq("date diff", FM.dateDiffDays("2026-06-03", "2026-06-05"), 2);

// ---------- invoice extraction ----------
const invoice = [
  "WORLD FUEL SERVICES",
  "Invoice Number: 88123456",
  "Invoice Date: 06/04/2026",
  "Delivery Date: 06/03/2026",
  "Aircraft Registration: N45XX",
  "Location: KASE  Aspen-Pitkin County",
  "Jet A  412.5 GAL @ 6.85",
  "Fuel subtotal $2,825.63",
  "Into-plane fee $85.00",
  "Taxes $214.12",
  "Invoice Total: $3,124.75",
].join("\n");
const f1 = FM.extractInvoiceFields(invoice, { knownTails: ["N45XX", "N525CJ"], knownAirports: ["KAUS", "KASE"] });
eq("inv tail", f1.tail, "N45XX");
eq("inv delivery date beats invoice date", f1.date, "2026-06-03");
eq("inv airport", f1.airport, "KASE");
eq("inv gallons", f1.gallons, 412.5);
eq("inv total picks invoice total", f1.total, 3124.75);
eq("inv number", f1.invoiceNumber, "88123456");

// No labels at all — falls back to generic patterns.
const f2 = FM.extractInvoiceFields("N525CJ fueled at KDAL 06/10/2026\n180.0 gallons\n$1,306.80", {});
eq("inv fallback tail", f2.tail, "N525CJ");
eq("inv fallback airport", f2.airport, "KDAL");
eq("inv fallback gallons", f2.gallons, 180);
eq("inv fallback total", f2.total, 1306.8);

// Known-airport search matches the 3-letter form in text.
const f3 = FM.extractInvoiceFields("Fuel ticket N45XX 06/07/2026 at AUS ramp\nTotal Due $900.00", { knownAirports: ["KAUS"] });
eq("inv known airport 3-letter", f3.airport, "KAUS");

// Real World Fuel layout (fictionalized): table headers and values land on
// separate lines, the fueling date is labeled DATE UPLIFTED, amounts carry no
// dollar signs, and the payable line says PLEASE REMIT THIS AMOUNT.
const wfs = [
  "WORLD FUEL SERVICES, INC.", "9800 N.W. 41st STREET SUITE 400", "MIAMI, FL 33178",
  "INVOICE",
  "CUSTOMER NO.", "INVOICE NO.", "INVOICE DATE", "PAGE NO.",
  "123456", "12345678-90123", "18-AUG-2026", "1 - 1",
  "REMIT TO:", "WORLD FUEL SERVICES", "CHICAGO, IL 60674-0024",
  "DATE UPLIFTED", "FUEL TICKET", "AIRCRAFT TYPE", "FLIGHT NO.", "PO NO./CONTRACT NO.", "TERMS",
  "15-AUG-2026", "001974", "N/A", "N/A", "N/A", "21 NET",
  "TAIL NO.", "LOCATION", "TERRITORY", "DESTINATION", "DUE DATE", "CONTACT",
  "N45XX/N45XX", "GUC / KGUC", "COLORADO", "N/A", "08-SEP-2026", "Garrett, Scott",
  "DESCRIPTION", "QUANTITY", "UNIT PRICE", "EXTENDED AMOUNT", "TAX AMOUNT", "INVOICE AMOUNT",
  "USD", "USD", "USD",
  "JET FUEL WITH ADDITIVE", "60.00 USG", "9.63383 USD/USG", "578.03", "0.00", "578.03",
  "SALES TAX", "1 EA", "28.32000 USD/EA", "28.32", "0.00", "28.32",
  "AIRPORT CHARGES", "1 EA", "54.12000 USD/EA", "54.12", "0.00", "54.12",
  "660.47", "0.00", "660.47",
  "COMMENTS", "Customer Card No.: *0685", "FBO Name: AVFLIGHT GUNNISON CORPORATION",
  "MAIL INSTRUCTIONS", "ELECTRONIC", "SALES ORDER NO.", "34520318",
  "PLEASE REMIT THIS AMOUNT", "USD 660.47",
].join("\n");
const w1 = FM.extractInvoiceFields(wfs, { knownTails: ["N45XX", "N525CJ"], knownAirports: ["KAUS", "KGUC"] });
eq("wfs tail", w1.tail, "N45XX");
eq("wfs uplift date not invoice date", w1.date, "2026-08-15");
eq("wfs airport from known list", w1.airport, "KGUC");
eq("wfs gallons", w1.gallons, 60);
eq("wfs remit total, no dollar sign", w1.total, 660.47);
eq("wfs dashed invoice number past customer number", w1.invoiceNumber, "12345678-90123");

// Same invoice with no flight log loaded yet: the location label window
// still finds the K-code, and the unit price never beats the remit amount.
const w2 = FM.extractInvoiceFields(wfs, {});
eq("wfs airport via location window", w2.airport, "KGUC");
eq("wfs total without known context", w2.total, 660.47);
eq("wfs date without known context", w2.date, "2026-08-15");

// No date label at all: the earliest date wins (uplift precedes invoice
// and due dates), not the first one in the text.
const w3 = FM.extractInvoiceFields("Invoice 18-AUG-2026\nFueled N45XX 15-AUG-2026 KGUC\nDue 08-SEP-2026\nUSD 660.47 remit", {});
eq("wfs earliest-date fallback", w3.date, "2026-08-15");

// ---------- matching ----------
const legs = [
  { date: "2026-06-03", tail: "N45XX", from: "KAUS", to: "KASE", family: "Smith" },
  { date: "2026-06-05", tail: "N45XX", from: "KASE", to: "KAUS", family: "Smith" },
  { date: "2026-06-05", tail: "N525CJ", from: "KAUS", to: "KHOU", family: "Jones" },
  { date: "2026-06-10", tail: "N45XX", from: "KAUS", to: "KSDL", family: "Miller" },
];

// Exact date + departure airport → auto.
let m = FM.matchFuelToLegs({ date: "2026-06-03", tail: "N45XX", airport: "KAUS" }, legs);
eq("match exact leg", m.index, 0);
eq("match exact status", m.status, "auto");

// Fuel invoiced the day after a leg, at the arrival airport of leg 0 =
// departure airport of leg 1? KASE departure on 6/5, invoice dated 6/5.
m = FM.matchFuelToLegs({ date: "2026-06-05", tail: "N45XX", airport: "ASE" }, legs);
eq("match K-prefix airport leg", m.index, 1);
eq("match K-prefix status", m.status, "auto");

// Tail keeps the two same-day legs apart.
m = FM.matchFuelToLegs({ date: "2026-06-05", tail: "N525CJ", airport: "KAUS" }, legs);
eq("match tail disambiguates", m.index, 2);

// Day-late invoice with matching departure airport still lands.
m = FM.matchFuelToLegs({ date: "2026-06-11", tail: "N45XX", airport: "KAUS" }, legs);
eq("match day-late", m.index, 3);
eq("match day-late status", m.status, "auto");

// No airport parsed, unique candidate → auto with lower score.
m = FM.matchFuelToLegs({ date: "2026-06-10", tail: "N45XX", airport: "" }, legs);
eq("match no airport", m.index, 3);
eq("match no airport status", m.status, "auto");

// Wrong tail → unmatched.
m = FM.matchFuelToLegs({ date: "2026-06-03", tail: "N999ZZ", airport: "KAUS" }, legs);
eq("match wrong tail", m.status, "unmatched");

// Airport that contradicts both ends → review, not silent auto.
m = FM.matchFuelToLegs({ date: "2026-06-03", tail: "N45XX", airport: "KLAX" }, legs);
eq("match contradicting airport status", m.status, "review");

// Ambiguity: two same-tail legs on the same date, no airport → review.
const ambiguousLegs = [
  { date: "2026-06-03", tail: "N45XX", from: "KAUS", to: "KASE", family: "Smith" },
  { date: "2026-06-03", tail: "N45XX", from: "KASE", to: "KAUS", family: "Jones" },
];
m = FM.matchFuelToLegs({ date: "2026-06-03", tail: "N45XX", airport: "" }, ambiguousLegs);
eq("match ambiguous status", m.status, "review");

// ---------- statement ----------
const fuel = [
  { date: "2026-06-03", tail: "N45XX", airport: "KAUS", gallons: 400, total: 3000, invoiceNumber: "A1", matchIndex: 0 },
  { date: "2026-06-05", tail: "N45XX", airport: "KASE", gallons: 350, total: 2900, invoiceNumber: "A2", matchIndex: 1 },
  { date: "2026-06-05", tail: "N525CJ", airport: "KAUS", gallons: 180, total: 1300, invoiceNumber: "B1", matchIndex: 2 },
  { date: "2026-07-01", tail: "N45XX", airport: "KAUS", gallons: 100, total: 800, invoiceNumber: "C1", matchIndex: -1 },
  { date: "2026-06-10", tail: "N45XX", airport: "KAUS", gallons: 50, total: 400, invoiceNumber: "D1", matchIndex: 3, familyOverride: "Davis" },
];
const st = FM.buildStatement(fuel, legs, null);
eq("stmt smith total", st.families["Smith"].total, 5900);
eq("stmt jones total", st.families["Jones"].total, 1300);
eq("stmt override wins", st.families["Davis"].total, 400);
eq("stmt unmatched goes unassigned", st.families["Unassigned"].total, 800);
eq("stmt line count", st.lines.length, 5);
check("stmt lines sorted", st.lines[0].date <= st.lines[st.lines.length - 1].date);

const stJune = FM.buildStatement(fuel, legs, "2026-06");
eq("stmt month filter", stJune.lines.length, 4);
check("stmt month excludes july", !stJune.families["Unassigned"]);

const csvOut = FM.statementCSV(st);
check("csv has header", csvOut.startsWith("Date,Family,Tail"));
check("csv has smith rollup", csvOut.includes("Smith,2,750,5900.00"));

// ---------- per-family bills ----------
const bills = FM.familyBills(st);
eq("bills family count", bills.length, 4);
const smithBill = bills.find((b) => b.family === "Smith");
eq("bill line count", smithBill.lines.length, 2);
eq("bill total", smithBill.total, 5900);
eq("bill gallons", smithBill.gallons, 750);
check("bills sorted by family", bills[0].family <= bills[bills.length - 1].family);

const billText = FM.familyBillText(smithBill, "2026-06");
check("bill text names family", billText.includes("FUEL BILL — Smith"));
check("bill text has period", billText.includes("Period: 2026-06"));
check("bill text has total", billText.includes("TOTAL DUE: $5900.00"));
check("bill text itemizes", billText.includes("2026-06-03") && billText.includes("2026-06-05"));

const billCsv = FM.familyBillCSV(smithBill);
check("bill csv header", billCsv.startsWith("Date,Tail,Airport"));
check("bill csv total row", billCsv.includes("Total due,,,750,5900.00"));

// ---------- durations ----------
eq("dur decimal", FM.parseDuration("2.5"), 2.5);
eq("dur h:mm", FM.parseDuration("2:30"), 2.5);
eq("dur h+mm", FM.parseDuration("1+45"), 1.75);
eq("dur h:mm:ss", FM.parseDuration("2:30:00"), 2.5);
eq("dur integer", FM.parseDuration("3"), 3);
eq("dur zero", FM.parseDuration("0"), null);
eq("dur garbage", FM.parseDuration("N/A"), null);
eq("dur empty", FM.parseDuration(""), null);

// ---------- column detection: flight time ----------
const cols3 = FM.detectColumns(["Date", "Tail", "Dep Time", "Arr Time", "Flight Time", "From", "To", "Passenger"]);
eq("detect flight time not dep/arr time", cols3.time, 4);
eq("detect date skips times", cols3.date, 0);

// ---------- monthly missing-bill checks ----------
const chkLegs = [
  { date: "2026-06-03", tail: "N45XX", hours: 2.0 },
  { date: "2026-06-05", tail: "N45XX", hours: 2.0 },
  { date: "2026-06-08", tail: "N525CJ", hours: 1.5 },
  { date: "2026-07-02", tail: "N45XX", hours: 3.0 },
];
const chkFuel = [
  { date: "2026-06-03", tail: "N45XX", gallons: 400 },
  { date: "2026-06-05", tail: "N45XX", gallons: 380 },
  { date: "2026-07-15", tail: "N525CJ", gallons: 100 },
];
const gph = { N45XX: 200, N525CJ: 120 };
const checks = FM.monthlyChecks(chkLegs, chkFuel, gph, null);

// N45XX June: 4 hrs * 200 = 800 expected, 780 invoiced -> ok.
let c = checks.find((x) => x.tail === "N45XX" && x.month === "2026-06");
eq("check ok level", c.level, "ok");
check("check ok mentions complete", c.message.includes("looks complete"));

// N525CJ June: flights but zero bills -> warn.
c = checks.find((x) => x.tail === "N525CJ" && x.month === "2026-06");
eq("check no-bills level", c.level, "warn");
check("check no-bills message", c.message.includes("no fuel bills"));

// N45XX July: 3 hrs * 200 = 600 expected, 0 gal but 0 bills -> the
// zero-bill flag wins.
c = checks.find((x) => x.tail === "N45XX" && x.month === "2026-07");
eq("check july level", c.level, "warn");

// N525CJ July: a bill with no flights that month -> warn the other way.
c = checks.find((x) => x.tail === "N525CJ" && x.month === "2026-07");
eq("check orphan bill level", c.level, "warn");
check("check orphan bill message", c.message.includes("no flights"));

// Shortfall: bills exist but gallons far under the hours flown.
const shortChecks = FM.monthlyChecks(
  [{ date: "2026-06-03", tail: "N45XX", hours: 10 }],
  [{ date: "2026-06-03", tail: "N45XX", gallons: 500 }],
  { N45XX: 200 }, null);
eq("check shortfall level", shortChecks[0].level, "warn");
check("check shortfall message", shortChecks[0].message.includes("possible missing fuel bill"));

// Same data without a burn rate: no volume opinion, structural check only.
const noGph = FM.monthlyChecks(
  [{ date: "2026-06-03", tail: "N45XX", hours: 10 }],
  [{ date: "2026-06-03", tail: "N45XX", gallons: 500 }],
  {}, null);
eq("check no-gph level", noGph[0].level, "ok");

// Month filter narrows the report.
const juneOnly = FM.monthlyChecks(chkLegs, chkFuel, gph, "2026-06");
check("check month filter", juneOnly.every((x) => x.month === "2026-06"));
eq("check month filter count", juneOnly.length, 2);

// ---------- yearly miles ----------
const ausDal = FM.airportNM("KAUS", "KDAL");
check("nm AUS-DAL plausible", ausDal > 150 && ausDal < 185);
check("nm K-prefix tolerant", Math.abs(FM.airportNM("AUS", "DAL") - ausDal) < 0.01);
eq("nm unknown airport", FM.airportNM("KAUS", "XXXX"), null);

const mileLegs = [
  { date: "2026-06-03", tail: "N318SA", from: "KAUS", to: "KASE" },          // exact
  { date: "2026-06-05", tail: "N318SA", from: "KASE", to: "KAUS" },          // exact
  { date: "2026-07-01", tail: "N318SA", from: "", to: "", hours: 2.0 },      // estimated
  { date: "2026-07-02", tail: "N318SA", from: "", to: "" },                  // skipped
  { date: "2025-05-01", tail: "N318SA", from: "KAUS", to: "KDAL" },          // wrong year
  { date: "2026-06-10", tail: "N929MM", from: "KAUS", to: "KHOU" },          // other tail
];
const ym = FM.yearlyMiles(mileLegs, 2026, { N318SA: 445, N929MM: 380 });
eq("miles tails", ym.length, 2);
const lear = ym.find((m) => m.tail === "N318SA");
eq("miles legs counted", lear.legs, 3);
eq("miles estimated count", lear.estimated, 1);
eq("miles skipped count", lear.skipped, 1);
check("miles total plausible", lear.nm > 1900 && lear.nm < 2400); // 2x ~600 + 890
const cj = ym.find((m) => m.tail === "N929MM");
check("miles cj plausible", cj.nm > 100 && cj.nm < 200);

// ---------- PDF extraction (synthetic Flate-compressed PDF) ----------
function buildPdf(text) {
  const lines = text.split("\n");
  let content = "BT /F1 10 Tf 40 700 Td\n";
  for (const line of lines) {
    content += "(" + line.replace(/([\\()])/g, "\\$1") + ") Tj 0 -14 Td\n";
  }
  content += "ET";
  const deflated = zlib.deflateSync(Buffer.from(content, "latin1"));
  const parts = [];
  parts.push(Buffer.from("%PDF-1.4\n"));
  parts.push(Buffer.from("1 0 obj\n<< /Length " + deflated.length + " /Filter /FlateDecode >>\nstream\n"));
  parts.push(deflated);
  parts.push(Buffer.from("\nendstream\nendobj\n%%EOF\n"));
  return Buffer.concat(parts);
}

async function pdfTests() {
  if (typeof DecompressionStream === "undefined") {
    console.log("(skipping PDF tests: no DecompressionStream in this node)");
    return;
  }
  const pdf = buildPdf(invoice);
  const res = await extractPdfText(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  check("pdf extract ok", res.ok);
  check("pdf keeps tail", res.text.includes("N45XX"));
  check("pdf keeps total", res.text.includes("3,124.75"));
  const f = FM.extractInvoiceFields(res.text, { knownTails: ["N45XX"], knownAirports: ["KASE"] });
  eq("pdf roundtrip date", f.date, "2026-06-03");
  eq("pdf roundtrip total", f.total, 3124.75);
  eq("pdf roundtrip gallons", f.gallons, 412.5);

  const notPdf = await extractPdfText(new TextEncoder().encode("hello world").buffer);
  check("non-pdf rejected", !notPdf.ok);

  // A PDF with no text layer (empty content) reports a scan, not garbage.
  const empty = Buffer.from("%PDF-1.4\n%%EOF\n");
  const res2 = await extractPdfText(empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength));
  check("scan-like pdf rejected", !res2.ok);
}

pdfTests().then(() => {
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
});
