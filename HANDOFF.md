# Handoff notes

Context for anyone — human or AI — picking this repo up cold.

## What this is

A register-style web app for a two-jet partnership. Kelley (pilot-manager)
flies and manages a **Lear 45 (N318SA)** and a **Citation CJ1+ (N929MM)** for
four equal-equity families: **CJIG, VIRTUS, ETAP, ZEMOG**. World Fuel
Services supplies fuel; Airplane Manager holds the flight log. The app ties
each World Fuel invoice to whoever was flying that day and produces
per-family bills. It is in real use — treat the money logic accordingly.

## Architecture

Zero dependencies, no build step. GitHub Pages serves the repo as-is.

- `index.html` — the whole UI and app wiring. Two tabs: **Attach** (drop a
  fuel bill / flight log, everything auto-assigns; a "Needs a look" card
  appears only for lines the matcher could not settle) and **Statements**
  (per-month family bills with email/text/print/CSV).
- `match.js` — ALL matching, billing, and miles math. UMD: browser global
  `FuelMatch` + node `module.exports`. Money logic changes go here and only
  here, with tests. Must stay node-compatible (automation depends on it).
- `pdf-text.js` — in-browser PDF text extraction (FlateDecode stream scan
  via DecompressionStream, Tj/TJ text ops, printable-ratio guard).
- `tests/` — `node run_tests.js`, expect exactly `121 passed, 0 failed`.
- `.github/workflows/` — push to `main` runs the tests, then deploys Pages.
  Do not modify the workflow; never push with failing tests — a red test
  job blocks the deploy, which is the point.

## Business rules (the part that must not drift)

- **Uplift-goes-to-the-trip**: fuel bought on a leg is billed 100% to the
  family flying that leg. No pro-rating, no deductions.
- **Tail must match**: a bill never crosses airplanes.
- Invoice date may slip up to **2 days** from the leg date; a
  departure-airport hit outranks an arrival hit; `KAUS` ≡ `AUS`.
- **Ambiguity → status "review"**, surfaced to a human. Never silently
  guess where money lands.
- An explicit family choice on a fuel line settles it, whatever its match
  status.
- Missing-bill check warns only when a month's invoiced gallons fall below
  **70%** of hours × gal/hr — tankering and price-shopping make fuel lumpy,
  so small gaps are normal.

## World Fuel invoice quirks (learned from real invoices)

- The date label may be `DATE UPLIFTED`; labels and values often sit on
  separate lines, so extraction window-searches near labels instead of
  same-line regexing.
- Amounts carry no `$`; the total is labeled `PLEASE REMIT THIS AMOUNT`;
  invoice numbers can be dashed (`12345678-90123`).
- Fallback when no labeled date parses: the earliest date on the invoice.

## Landmines

- The lock screen is **decorative, not security** (master code `maverick`,
  djb2-hashed in the page source). Real privacy = user records never live
  in this public repo.
- iOS sound: the unlock audio must start synchronously inside the tap — an
  `await` before `.play()` forfeits the gesture. The `<audio>` WAV data-URI
  plays through the ring/silent switch; Web Audio does not.
- User data lives in `localStorage` key `fuelsplit-v1`. Optional cloud sync
  mirrors state to a **private** repo (`Settings → Cloud sync`: repo +
  fine-grained PAT with Contents read/write; file `data/state.json`;
  last-write-wins on `updatedAt`). Never point sync at a public repo.
- `AIRPORT_COORDS` in `match.js` is generated from OurAirports
  public-domain data (3,473 fields). If you regenerate it, preserve all
  existing keys — yearly-miles history depends on them.
- `APP_BUILD` in `index.html` is shown in Settings so a phone can be
  compared against the deployed version. Update it with any user-visible
  change.
- Owner strings from the flight log map to families via learned chips
  (`ownerMap`), remembered per device.
- A monthly automation (Claude, on the owner's account) emails the owner a
  statement and per-family bill texts parsed from his Gmail; it clones this
  repo and drives `match.js` under node.

## Working on it

1. Edit. 2. `cd tests && node run_tests.js` — keep it green, and add tests
for any money-logic change. 3. Push to `main`. 4. Confirm the Actions run
went green — that is the deploy.

Requirements from the owner often arrive by voice-to-text and garble.
Confirm your reading of anything that moves money before building it.
