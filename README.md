# Product Collector

A local browser app for collecting product details, gallery images, and sizes from ASOS, Boohoo, and PrettyLittleThing. Paste up to 50 product links, review the results, and download Shopify CSV, structured JSON, or an image ZIP.

## Start on Windows

Install Node.js 22.12+ (Node.js 24 is recommended). From this folder:

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

Open **http://localhost:4317** in your browser. Keep the terminal running. Press Ctrl+C to stop. After the first installation, you can double-click **start-local.cmd** to build and start the app.

The server listens only on `127.0.0.1`. To use a different port:

```powershell
$env:PORT = "4318"
npm.cmd start
```

If the default port is already in use, close the other Product Collector terminal or select a different port. This app does not terminate existing processes.

## Collect and review

1. Paste product links or complete share messages with colour and UK size notes. Mix all three retailers in a batch.
   PrettyLittleThing `https://plt.mobi/…` and Boohoo `https://bhoo.mobi/…` share links are supported. Include the full share code after the domain. They are resolved to the same retailer's full product URL while preserving its selected color and region. Expired links and links that lead to a category page are reported as failures.
2. Click **Collect products**. Duplicate links and tracking parameters are removed; color and region selections are preserved.
3. Click **Review** to edit the title, description, brand, and product type, inspect sizes, and exclude images. Uncheck a product to exclude it from exports.
4. Download **Shopify CSV**, **JSON**, or **Image ZIP**. Completed products can be exported while other links are still running.

Descriptions use the site's **Product Details** content. ASOS descriptions preserve its feature bullets, product code, care instructions, fabric composition, and brand text. Boohoo and PLT preserve their product description and Product Details & Care content. Formatting is sanitized, without rewriting the text. Shipping, payment, and recommendation sections are excluded. You can edit the description before exporting.

Plain links collect the linked colour and every listed size, including sold-out sizes. Size notes collect only the requested sizes and colours, with separate results for each colour. Size labels remain as the retailer displays them. Unknown availability stays unknown. Retailer stock quantities are never inferred.

### Size notes and quantity checks

Paste notes below their product link, for example:

```text
Check out this item I found on Boohoo https://bhoo.mobi/example123
7
White (uk 14,16,18)
Cream floral ( uk 10,12)
Brown uk (16,16)
```

Each size occurrence represents one unit: Brown UK 16 above becomes one variant with quantity 2. A standalone number checks the whole product's total; a number before brackets checks that colour's total. `2(Uk 10 12)` and `Burnt orange 3(uk 10,12,)` are supported, as are mixed commas/spaces, trailing commas, and UK inside or outside brackets. `3(12,12)` flags expected 3 versus listed 2. Counts never fill in missing units or override the size list.

The input preview shows size quantities and mismatches. Correct mismatches in the input and collect again before exporting either CSV. Missing requested sizes or unverified colours also block CSV export. JSON retains the original notes, quantity checks, requested quantities and errors. Plain links still initialize inventory at zero. Explicit size notes provide quantities only to the separate inventory CSV, never the product CSV. UK requests match explicit UK labels or bare numeric labels on a UK storefront; the app does not convert foreign sizes.

## Browser-assisted retry

If a page requires JavaScript, the app first tries an isolated headless browser. On Windows it uses installed Microsoft Edge when available. Otherwise install the bundled Chromium once:

```powershell
npm.cmd run browser:install
```

Choose **Retry in browser** to open a visible, isolated browser. Complete any retailer verification or cookie selection yourself, return to the app, and click **Continue extraction**. Stay on the same product and color. Close the browser or click **Close browser** to cancel this attempt. Sessions expire after five minutes.

This does not use your normal browser profile, saved passwords, or cookies. No CAPTCHA-solving service, proxy service, login automation, or paid API is included. Some retailer restrictions can persist even with an interactive browser; these are reported as failures. Never assume that all links will always be accessible.

## Output behavior

### Shopify CSV

- Uses Shopify product CSV headers, UTF-8 encoding, LF line endings, one row per variant, and additional image rows when needed.
- Products are **draft** and **unpublished**.
- **Inventory tracking is enabled for every variant:** Inventory tracker is `shopify`, Continue selling when out of stock is `deny`, and Fulfillment service is `manual`. Extra image-only rows leave these fields blank.
- **No price, compare-at price, cost, currency, or inventory quantity columns.** Shopify assigns default prices and stock quantities of zero to newly imported variants when these values are omitted. Set your own prices and quantities before publishing; retailer availability is never used as your stock count.
- Vendor is determined by the source retailer: **ASOS**, **Boohoo**, or **Pretty Little Thing**. The extracted product brand is kept separately in the review screen and JSON. Extracted product type maps to Type. Verified retailer SKUs are preserved. Missing SKUs remain blank.
- Products with unverified sizes or missing titles must be retried or excluded before CSV export; JSON can still contain their partial results.
- Only selected, publicly downloadable image URLs appear in CSV. A downloaded ZIP image is not a Shopify-hosted URL. Shopify must still be able to fetch retailer URLs at import time.
- Spreadsheet formula-like text is escaped for safer opening in spreadsheet software.

Import using Shopify **Products → Import**. The tool prepares files; it does not log in to Shopify, publish products, or update a store. Review Shopify's import preview before importing. See [Shopify's CSV documentation](https://help.shopify.com/en/manual/products/import-export/using-csv).

### Warehouse inventory CSV

Product CSV inventory tracking applies to the variant; it does not stock every store location. To initialize a warehouse:

1. Import **Shopify CSV** under **Products → Import** and wait for it to finish.
2. In the app, enter the exact, case-sensitive existing Shopify location name (defaults to **Warehouse**) and download **Inventory CSV**.
3. Import `shopify-inventory.csv` under **Products → Inventory → Import**. Review the import summary before starting.
4. Review the quantities before publishing. Size notes supply quantities; plain links initialize at zero.

The inventory file has one row per selected variant, matching the product CSV's handles and options. It initializes the chosen location using **the occurrence count of each requested size**, or **zero** for plain links, including retailer sold-out variants. It sets `On hand (current)` to `not stocked`, retaining Shopify's comparison check: already-stocked locations can reject these rows instead of having their counts silently overwritten. Only the named location is included; other locations are unaffected. It does not create a location, move stock, or set prices. For previously imported products, handles and options must still match; no product reimport is needed if they already do. To adjust existing stock, export fresh inventory from Shopify and edit that file instead.

See [Shopify's inventory CSV instructions](https://help.shopify.com/en/manual/products/inventory/setup/inventory-csv). The authenticated export endpoint is `GET /api/batches/:id/export/inventory?location=Warehouse`.

### JSON

Versioned product data with source URLs/IDs, extraction times, descriptions, variants, retailer availability, selected images, warnings, and per-link errors. Schema version `1.1` adds a retailer-based `vendor` alongside the original `brand`, plus `inventoryTracker: "shopify"`, `inventoryPolicy: "deny"`, and `fulfillmentService: "manual"` to every exported variant, matching the CSV defaults. This is an integration format, **not a native Shopify JSON upload file or Admin API request payload**. No pricing fields are included. Size-note inputs add `requestedSelection`, `selectionErrors` and per-variant `requestedQuantity`; these quantities come from your notes, not retailer inventory.

### Image ZIP

Selected gallery images are grouped by stable product handle and numbered in gallery order. `manifest.json` maps files to source URLs and lists download failures. ASOS images use the largest uncropped rendition published in the product page's responsive gallery; its base image URLs can otherwise return small thumbnails. The same selected image URLs are used in previews, CSV, JSON, and ZIP. The tool does not enlarge images or invent higher-resolution URLs. Each image is limited to 15 MB, each product to 30 gallery images, and each ZIP to 300 MB. An inaccessible image does not prevent the other images from downloading.

## Session, data, and network limits

- Two products are processed at a time, with one active extraction per retailer. Automatic requests have bounded timeouts and retries. Interactive sessions occupy an extraction slot.
- Batches live only in server memory. Refreshing the same browser tab reconnects to its batch; restarting the server clears batches. Up to 20 recent batches are retained in memory; the oldest completed batch is discarded when needed.
- Product/color duplicates discovered after extraction are excluded. Exports deduplicate product IDs even if a duplicate is reselected.
- URLs and redirects are restricted to supported retailer domains. Fetches reject private, loopback, link-local, and reserved network targets, including at DNS connection time. Download sizes are bounded, and image file signatures are validated.
- The browser retry routes requests through the same public-only transport. No files are automatically written outside the app by extraction; exports go to your browser's download location.
- The app does not crawl category pages or recommendations. It collects other product colours only when explicitly named in size notes. Legacy links that redirect to a category are reported as unavailable.
- There is no database, cloud deployment, scheduled scraping, user account, persistent job history, or direct Shopify connection.

## Development and checks

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run check:live
```

With the app running, `npm.cmd run check:api` checks the HTTP flow using a live mixed batch, edits, image selection, session protection, and all three exports. It saves reviewable files under `.local/qa/`.

`check:live` makes actual requests to one representative product from each retailer and saves results under ignored `.local/live/`. You can pass replacement product URLs after `--`. Live pages change, so automated tests use reduced public product fixtures in `tests/fixtures/` instead. Tests cover descriptions, variants, colors, sold-out sizes, missing data, gallery deduplication, CSV/JSON, ZIP failures, network validation, queue concurrency, cancellation, retries, and edits.

Run `npm.cmd run dev` before a production build for the Vite middleware workflow. When `dist/` exists, the server serves that production build; rerun `npm.cmd run build` after frontend edits. Server edits require restarting the server. The code is TypeScript throughout.

The local API uses a per-process session token from `GET /api/session` in `X-Session-Token` for batch and export endpoints. Mutating routes also reject cross-origin requests. This is a local application interface, not a publicly exposed service.

## Implementation layout

- `server/adapters/`: ASOS, Boohoo, and PLT extraction and shared parsers.
- `server/jobs.ts`, `server/browser.ts`, `server/network.ts`: queue, assisted browser, and guarded network requests.
- `server/exports.ts`: Shopify CSV, versioned JSON, and streamed ZIP.
- `src/`: plain TypeScript browser UI and styles.
- `shared/types.ts`: normalized product and batch interfaces.

The Shopify file structure is tested locally. An import into an authenticated Shopify store is not part of the automated test suite.
