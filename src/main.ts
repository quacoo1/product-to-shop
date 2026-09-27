import './style.css';
import { ApiError, readApiJson, responseError } from './api';
import type { Batch, ExtractionResult, Product } from '../shared/types';
import { RETAILER_VENDORS } from '../shared/types';
import { inputLinks, parseProductInput, quantityErrors } from '../shared/input';

const icon = (name: string, cls = '') => {
  const paths: Record<string, string> = {
    bag: '<path d="M5 7h14v14H5zM9 7V3h6v4"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    link: '<path d="m10 13 4-4M9 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    file: '<path d="M5 3h9l5 5v13H5zM14 3v5h5M8 13h8M8 17h5"/>',
    browser: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M6 6.5h.01M9 6.5h.01"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 17 5-5 4 4 4-6 5 7"/><circle cx="8" cy="8" r="1"/>',
    edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14z"/>',
    alert: '<path d="m12 3 10 18H2zM12 9v5m0 3v1"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  };
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.file}</svg>`;
};
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]!));
const retailerName = (retailer?: string) => ({ asos: 'ASOS', boohoo: 'Boohoo', prettylittlething: 'PrettyLittleThing' }[retailer ?? ''] || 'Link');
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar"><a class="brand" href="/" aria-label="Product Collector home"><span class="brand-mark">${icon('bag')}</span>product<span class="brand-light">collector</span></a><div class="account-actions"><span class="local-badge"><span></span> YOUR WORKSPACE</span><button id="sign-out" class="secondary compact" hidden>Sign out</button></div></header>
  <main id="login-screen" class="login-screen" aria-labelledby="login-title">
    <section class="login-intro">
      <span class="eyebrow">A LITTLE LESS ADMIN. A LOT MORE POSSIBILITY.</span>
      <h1>Your next collection<br>starts here.</h1>
      <p>Bring your product links together. Fine-tune the details, choose your sizes, and get your next listings ready.</p>
      <div class="login-workflow" aria-label="Your workflow"><span>${icon('link')} Collect</span><i aria-hidden="true"></i><span>${icon('edit')} Review</span><i aria-hidden="true"></i><span>${icon('download')} Export</span></div>
      <div class="login-retailers"><span>MADE FOR YOUR FINDS FROM</span><div>ASOS <b>boohoo</b> PrettyLittleThing</div></div>
    </section>
    <section class="login-card">
      <div class="login-symbol">${icon('lock')}</div><span class="eyebrow">PRODUCT COLLECTOR</span>
      <h2 id="login-title">Welcome back.</h2><p class="login-description">Sign in to collect, review, and export your products.</p>
      <div id="connection-state" class="connection-state" role="status"><span class="working">Checking your session…</span></div>
      <button id="retry-connection" class="secondary full" hidden>Try again ${icon('arrow')}</button>
      <form id="login-form" hidden>
        <label class="field-label" for="access-password">Access password</label>
        <div class="password-field"><input id="access-password" type="password" autocomplete="current-password" placeholder="Enter your password" aria-describedby="password-help login-error" required><button id="toggle-password" type="button" aria-label="Show password" aria-controls="access-password" aria-pressed="false">Show</button></div>
        <p id="login-error" class="error-text" role="alert"></p>
        <button id="login-submit" class="primary full" type="submit">Sign in ${icon('arrow')}</button>
        <p id="password-help" class="password-help">Use your workspace access password. If you don’t have it, ask the person who set up this app.</p>
      </form>
      <div class="login-card-footer">${icon('lock')} Your workspace, ready when you are.</div>
    </section>
    <p class="login-bottom-note">From your favourite finds to your next Shopify drafts.</p>
  </main>
  <main class="workspace" hidden>
    <div class="page-heading"><div><div class="eyebrow">PRODUCT IMPORTS</div><h1>From link to listing.</h1><p>Collect the details. Choose the images. Make it yours.</p></div><div class="steps"><span class="step active"><b>1</b> Collect</span><span class="step-line"></span><span class="step" id="review-step"><b>2</b> Review</span><span class="step-line"></span><span class="step" id="export-step"><b>3</b> Export</span></div></div>
    <div class="workspace-grid">
      <aside class="input-column">
        <section class="panel input-panel"><div class="panel-title"><h2>Add product links</h2><span class="number-pill">01</span></div><p class="muted">Paste product links or share messages with colour and UK size notes.</p>
          <div class="retailers"><span>ASOS</span><span>boohoo</span><span>PrettyLittleThing</span></div>
          <label class="field-label" for="links">Links and sizes <span id="link-count">0 / 50</span></label>
          <textarea id="links" spellcheck="false" placeholder="Check out this item I found on Boohoo https://bhoo.mobi/…&#10;White (UK 14,16,18)&#10;Cream floral (UK 10,12)&#10;Brown uk (16,16)" rows="9"></textarea>
          <p id="input-error" class="error-text" role="alert"></p>
          <div id="selection-preview" class="selection-preview" aria-live="polite" hidden></div>
          <button class="primary full" id="collect" disabled>Collect products ${icon('arrow')}</button>
          <div class="input-caption">${icon('link')} Add sizes to filter · plain links collect all sizes</div>
        </section>
        <section class="notes-panel"><span class="note-icon">${icon('file')}</span><div><h3>Ready for your Shopify drafts</h3><p>Prices are left out. Shopify defaults them to zero, so add your prices before publishing.</p><p class="small">Inventory tracking is enabled on import. Use the separate inventory CSV to stock a warehouse location, using the quantities in your size notes.</p></div></section>
        <div class="session-note">${icon('browser')} Your batch stays in this session.<br>Download your files before closing the app.</div>
      </aside>
      <section class="results-column" aria-label="Collection review">
        <section class="panel collection-panel"><div class="collection-header"><div class="collection-label">${icon('grid')}<h2>Your collection <span id="product-count">0</span></h2></div><button id="cancel" class="text-button" hidden>Cancel batch</button></div>
          <div id="progress" class="progress-section" hidden></div>
          <div id="results"><div class="empty-state"><div class="empty-symbol">${icon('bag')}</div><span class="eyebrow">A FRESH COLLECTION</span><h3>Your next listings start here</h3><p>Paste product links to collect their details,<br>images, and sizes in one place.</p><div class="empty-tags"><span>${icon('check')} Editable details</span><span>${icon('check')} Original images</span></div></div></div>
        </section>
        <section class="panel export-panel"><div><div class="eyebrow">TAKE IT TO YOUR STORE</div><h2>Export your collection</h2><p id="export-summary" class="muted">Review your products, then choose a format.</p></div><div class="export-buttons"><button class="primary" data-export="csv" disabled>${icon('download')} Shopify CSV</button><button class="secondary" data-export="json" disabled>JSON</button><button class="secondary" data-export="zip" disabled>${icon('image')} Image ZIP</button></div><p class="export-footnote">CSV imports into Shopify. JSON is for integrations. ZIP includes images and a download report.</p><div class="inventory-export"><h3>Stock a warehouse location</h3><p class="muted">First import the Shopify CSV under Products. Then import this inventory CSV under Products → Inventory → Import.</p><label class="field-label" for="inventory-location">Shopify location name</label><input id="inventory-location" value="Warehouse" maxlength="255" aria-describedby="inventory-help"><button class="secondary" data-export="inventory" disabled>${icon('download')} Inventory CSV</button><p id="inventory-help" class="export-footnote">Match the location name exactly. Each listed size counts as one unit. Repeated sizes add units of that size. Plain links initialize at 0. Quantity mismatches must be corrected before CSV export. Existing stock is protected by Shopify’s current-quantity check and may cause rows to be rejected. Use the same product handles and options as your product import.</p></div></section>
      </section>
    </div>
    <footer><span>PRODUCT COLLECTOR</span><span>No prices. No automatic publishing. You’re in control.</span></footer>
  </main>
  <div id="toast" role="status" aria-live="polite" hidden></div>
  <dialog id="editor"><form id="edit-form"><div class="dialog-header"><div><span class="eyebrow">REVIEW PRODUCT</span><h2>Make it yours</h2></div><button type="button" data-close class="icon-button" aria-label="Close editor">${icon('close')}</button></div><div id="editor-content"></div><div class="dialog-footer"><p id="edit-error" class="error-text" role="alert"></p><button type="button" data-close class="secondary">Cancel</button><button type="submit" class="primary">Save changes ${icon('check')}</button></div></form></dialog>
  <dialog id="html-dialog"><form id="html-form"><div class="dialog-header"><h2>Use a saved product page</h2><button type="button" id="html-close" class="icon-button" aria-label="Close upload">${icon('close')}</button></div><div class="upload-fields"><p>Open <a id="html-source-link" target="_blank" rel="noreferrer">the product page</a> in your browser and complete any verification yourself. Select the requested colour, then save the page as HTML only. Upload the saved file below.</p><label>Full product URL<input id="html-source-url" type="url" required placeholder="https://www.boohoo.com/product/…"></label><label>Saved HTML file (up to 2 MB)<input id="html-file" type="file" accept=".html,.htm,text/html" required></label><p class="muted small">Only the product page is needed. The file is parsed for product details and is not stored. If saving loses the page data, copy the rendered page HTML into a file instead.</p><p id="html-error" class="error-text" role="alert"></p></div><div class="dialog-footer"><button type="submit" class="primary">Extract saved page</button></div></form></dialog>
`;

let batch: Batch | undefined;
let token = '';
let cloudMode = false;
let processing = false;
let processErrorShown = false;
let revision = 0;
let uploadItemId: string | undefined;
let busy = false;
let downloading = false;
let editedId: string | undefined;
let lastRender = '';
let toastTimer: ReturnType<typeof setTimeout>;
const input = document.querySelector<HTMLTextAreaElement>('#links')!;
const dialog = document.querySelector<HTMLDialogElement>('#editor')!;
const htmlDialog = document.querySelector<HTMLDialogElement>('#html-dialog')!;
const loginScreen = document.querySelector<HTMLElement>('#login-screen')!;
const workspace = document.querySelector<HTMLElement>('.workspace')!;
const loginForm = document.querySelector<HTMLFormElement>('#login-form')!;
const passwordInput = document.querySelector<HTMLInputElement>('#access-password')!;
const loginButton = document.querySelector<HTMLButtonElement>('#login-submit')!;
const signOutButton = document.querySelector<HTMLButtonElement>('#sign-out')!;
const connectionState = document.querySelector<HTMLElement>('#connection-state')!;
const retryConnection = document.querySelector<HTMLButtonElement>('#retry-connection')!;
const emptyResults = document.querySelector('#results')!.innerHTML;
interface SessionInfo { token: string; mode?: string; latestBatch?: string; }
function setCloudMode() {
  cloudMode = true;
  document.querySelector('.local-badge')!.innerHTML = '<span></span> CLOUD WORKSPACE';
  document.querySelector('.session-note')!.textContent = 'Collections are saved for seven days. Keep this page open to process queued products; returning to the app resumes them.';
}
function showLogin() {
  setCloudMode(); token = '';
  revision++;
  workspace.hidden = true; loginScreen.hidden = false; loginForm.hidden = false;
  connectionState.hidden = true; retryConnection.hidden = true; signOutButton.hidden = true;
  dialog.close(); htmlDialog.close();
  document.title = 'Sign in · Product Collector';
  passwordInput.focus();
  document.querySelector<HTMLButtonElement>('#collect')!.disabled = true;
}
async function acceptSession(session: SessionInfo) {
  if (!session.token) throw new Error('The backend did not return a session token. Check the deployment configuration.');
  token = session.token;
  if (session.mode === 'cloud') setCloudMode();
  document.querySelector('#input-error')!.textContent = '';
  document.querySelector<HTMLButtonElement>('#collect')!.disabled = false;
  batch = undefined; lastRender = ''; processErrorShown = false;
  document.querySelector('#results')!.innerHTML = emptyResults;
  document.querySelector('#product-count')!.textContent = '0';
  document.querySelector<HTMLElement>('#progress')!.hidden = true;
  document.querySelector<HTMLElement>('#cancel')!.hidden = true;
  document.querySelectorAll('[data-export]').forEach(button => (button as HTMLButtonElement).disabled = true);
  document.querySelectorAll('#review-step, #export-step').forEach(step => step.classList.remove('active'));
  document.querySelector('#export-summary')!.textContent = 'Review your products, then choose a format.';
  const saved = sessionStorage.getItem('collector-batch') || session.latestBatch;
  if (saved) {
    try { batch = await request<Batch>(`/batches/${saved}`); sessionStorage.setItem('collector-batch', batch.id); render(); }
    catch (error) { sessionStorage.removeItem('collector-batch'); if (error instanceof ApiError && error.status === 401) throw error; }
  }
  loginScreen.hidden = true; workspace.hidden = false; signOutButton.hidden = !cloudMode;
  if (!cloudMode) document.querySelector('.local-badge')!.innerHTML = '<span></span> LOCAL WORKSPACE';
  document.title = 'Product Collector';
  input.focus();
}
function toast(message: string, error = false) {
  const element = document.querySelector<HTMLDivElement>('#toast')!;
  element.textContent = message; element.classList.toggle('toast-error', error); element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.hidden = true, error ? 9000 : 5000);
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'X-Session-Token': token, ...options.headers } });
  if (response.status === 401 && path !== '/login' && cloudMode) {
    showLogin();
    document.querySelector('#login-error')!.textContent = 'Your session expired. Sign in again to continue.';
  }
  return readApiJson<T>(response);
}
const urls = () => inputLinks(input.value);
input.addEventListener('input', () => {
  document.querySelector('#link-count')!.textContent = `${urls().length} / 50`;
  const preview = document.querySelector<HTMLDivElement>('#selection-preview')!;
  preview.hidden = true; preview.innerHTML = '';
  if (!input.value.trim()) return;
  try {
    const requests = parseProductInput(input.value).filter(r => r.selection);
    preview.hidden = requests.length === 0;
    preview.innerHTML = requests.map(r => {
      const s = r.selection!;
      const counts = [...new Set(s.sizes)].map(size => `${size} × ${s.sizes.filter(v => v === size).length}`).join(', ');
      const errors = quantityErrors(s);
      return `<div><strong>${escape(s.color || 'Linked colour')}</strong><p>${escape(counts)} · ${s.sizes.length} units</p>${errors.map(e => `<p class="error-text">${escape(e)}</p>`).join('')}</div>`;
    }).join('');
  } catch (error) { preview.hidden = false; preview.textContent = (error as Error).message; }
});
function imagePath(item: ExtractionResult, imageId: string) { return `/api/batches/${batch!.id}/items/${item.id}/images/${imageId}`; }
function productRow(item: ExtractionResult): string {
  const p = item.product!;
  const cover = p.images.find(i => i.included && i.validation === 'valid');
  const available = p.variants.filter(v => v.availability === 'available').length;
  const soldOut = p.variants.filter(v => v.availability === 'sold_out').length;
  return `<article class="product-row ${p.included ? '' : 'excluded'}"><label class="selection"><input type="checkbox" data-include="${item.id}" ${p.included ? 'checked' : ''} aria-label="Include ${escape(p.title)} in exports"></label><div class="product-cover">${cover ? `<img src="${imagePath(item, cover.id)}" alt="${escape(cover.alt)}" loading="lazy">` : icon('image')}</div><div class="product-info"><div class="product-meta"><span>${retailerName(p.retailer)}</span><span>·</span><span>${escape(p.color || 'Color unspecified')}</span></div><h3>${escape(p.title || 'Untitled product')}</h3><div class="product-stats"><span>${p.variants.length} sizes</span><span>${p.images.filter(i => i.included).length} images</span>${soldOut ? `<span>${soldOut} sold out</span>` : available ? `<span>${available} available</span>` : ''}</div>${p.warnings.length ? `<details class="warnings"><summary>${icon('alert')} ${p.warnings.length} ${p.warnings.length === 1 ? 'note' : 'notes'} to review</summary><ul>${p.warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul></details>` : '<span class="ready-label">Ready to review</span>'}</div><div class="row-actions"><button class="secondary compact" data-edit="${item.id}">${icon('edit')} Review</button><button class="text-button small" data-action="${cloudMode ? 'upload' : 'browser'}" data-id="${item.id}">${cloudMode ? 'Upload saved page' : 'Retry in browser'}</button><a class="source-link" href="${escape(p.sourceUrl)}" target="_blank" rel="noreferrer">View source ↗</a></div></article>`;
}
function statusRow(item: ExtractionResult): string {
  const active = ['queued', 'extracting'].includes(item.status);
  const labels: Record<string, string> = { queued: 'In the queue', extracting: 'Collecting product details…', needs_browser: cloudMode ? 'Saved page needed' : 'Browser retry needed', awaiting_user: 'Ready when you are', failed: 'Check this link', cancelled: 'Cancelled' };
  return `<article class="status-row"><div class="status-icon ${active ? 'working' : ''}">${icon(active ? 'link' : 'alert')}</div><div class="status-info"><span class="product-meta">${retailerName(item.retailer)}</span><h3>${labels[item.status]}</h3><p class="url-preview">${escape(item.url)}</p>${item.selection ? `<p class="error-detail">Requested: ${escape(item.selection.notes.join(" · "))}</p>` : ""}${item.error ? `<p class="error-detail">${escape(item.error)}</p>` : ''}${item.status === 'awaiting_user' ? '<p class="error-detail">Complete any verification in the browser window, then choose Continue extraction.</p>' : ''}</div><div class="row-actions">${item.status === 'awaiting_user' ? `<button class="primary compact" data-action="resume" data-id="${item.id}">Continue extraction</button><button class="text-button" data-action="close-browser" data-id="${item.id}">Close browser</button>` : !active && item.retailer ? `<button class="secondary compact" data-action="${cloudMode ? 'upload' : 'browser'}" data-id="${item.id}">${icon('browser')} ${cloudMode ? 'Upload saved page' : 'Retry in browser'}</button><button class="text-button" data-action="retry" data-id="${item.id}">Retry automatically</button>` : ''}</div></article>`;
}
function render() {
  if (!batch) return;
  const products = batch.items.filter(i => i.status === 'success' && i.product);
  const selected = products.filter(i => i.product!.included);
  const ready = selected.every(i => !!i.product!.title.trim() && i.product!.variants.length > 0 && !i.product!.selectionErrors?.length);
  const finished = batch.items.filter(i => !['queued','extracting','awaiting_user'].includes(i.status)).length;
  document.querySelector('#product-count')!.textContent = String(products.length);
  document.querySelector('#review-step')!.classList.toggle('active', products.length > 0);
  document.querySelector('#export-step')!.classList.toggle('active', selected.length > 0 && ready);
  const cancel = document.querySelector<HTMLButtonElement>('#cancel')!; cancel.hidden = !batch.running; cancel.disabled = busy;
  document.querySelector<HTMLButtonElement>('#collect')!.disabled = !token || batch.running || busy;
  const progress = document.querySelector<HTMLDivElement>('#progress')!; progress.hidden = false;
  progress.innerHTML = `<div class="progress-label"><span>${batch.running ? 'Collecting your products' : batch.cancelled ? 'Batch cancelled' : 'Collection complete'}</span><span>${finished} / ${batch.items.length} links${batch.duplicates ? ` · ${batch.duplicates} duplicate${batch.duplicates === 1 ? '' : 's'} skipped` : ''}</span></div><progress value="${finished}" max="${batch.items.length || 1}" aria-label="Extraction progress"></progress>`;
  const serialized = JSON.stringify(batch.items);
  if (serialized !== lastRender) { document.querySelector('#results')!.innerHTML = batch.items.map(i => i.status === 'success' && i.product ? productRow(i) : statusRow(i)).join(''); lastRender = serialized; }
  document.querySelector('#export-summary')!.textContent = selected.length ? `${selected.length} product${selected.length === 1 ? '' : 's'} selected · ${selected.reduce((n,i) => n + i.product!.variants.length,0)} variants${!ready ? ' · Verify quantities, colours, sizes or titles for CSV' : ''}` : 'Select products to include in your downloads.';
  document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach(button => { button.disabled = downloading || busy || (button.dataset.export === 'json' ? false : !selected.length) || (['csv', 'inventory'].includes(button.dataset.export!) && !ready); });
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.disabled = busy);
}
async function mutate(path: string, body?: unknown, method = 'POST') {
  revision++; busy = true; render();
  try { batch = await request<Batch>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); render(); }
  finally { revision++; busy = false; render(); }
}
document.querySelector('#collect')!.addEventListener('click', async () => {
  const error = document.querySelector('#input-error')!; error.textContent = '';
  if (!token) { error.textContent = 'Connect the backend and refresh before collecting products.'; return; }
  const links = urls();
  if (!links.length || links.length > 50) { error.textContent = 'Add between 1 and 50 product links, with optional colour and UK size notes.'; return; }
  try { parseProductInput(input.value); } catch (e) { error.textContent = (e as Error).message; return; }
  const button = document.querySelector<HTMLButtonElement>('#collect')!; button.disabled = true; busy = true;
  revision++;
  try {
    batch = await request<Batch>('/batches', { method: 'POST', body: JSON.stringify({ text: input.value }) });
    sessionStorage.setItem('collector-batch', batch.id); lastRender = ''; render();
  } catch (e) { error.textContent = (e as Error).message; }
  finally { revision++; busy = false; button.disabled = !token; render(); }
});
document.querySelector('#cancel')!.addEventListener('click', () => { if (batch) void mutate(`/batches/${batch.id}/cancel`).catch(e => toast(e.message, true)); });
document.querySelector('#results')!.addEventListener('click', async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button || !batch) return;
  if (button.dataset.edit) { showEditor(button.dataset.edit); return; }
  if (button.dataset.action === 'upload') {
    const item = batch.items.find(i => i.id === button.dataset.id)!;
    uploadItemId = item.id;
    document.querySelector<HTMLAnchorElement>('#html-source-link')!.href = item.resolvedUrl || item.url;
    document.querySelector<HTMLInputElement>('#html-source-url')!.value = item.resolvedUrl || (item.url.includes('.mobi/') ? '' : item.url);
    document.querySelector<HTMLInputElement>('#html-file')!.value = '';
    document.querySelector('#html-error')!.textContent = '';
    htmlDialog.showModal(); return;
  }
  if (button.dataset.action) {
    if (button.dataset.action === 'browser') toast('Opening a browser window. Complete any verification there, then return here.');
    try { await mutate(`/batches/${batch.id}/items/${button.dataset.id}/${button.dataset.action}`); }
    catch (e) { toast((e as Error).message, true); }
  }
});
document.querySelector('#results')!.addEventListener('change', async event => {
  const checkbox = event.target as HTMLInputElement; if (!checkbox.dataset.include || !batch) return;
  try { await mutate(`/batches/${batch.id}/items/${checkbox.dataset.include}`, { included: checkbox.checked }, 'PATCH'); }
  catch (e) { checkbox.checked = !checkbox.checked; toast((e as Error).message, true); }
});
function showEditor(id: string) {
  const item = batch!.items.find(i => i.id === id)!; const p = item.product!; editedId = id;
  document.querySelector('#edit-error')!.textContent = '';
  document.querySelector('#editor-content')!.innerHTML = `<div class="editor-fields"><label>Title<input name="title" value="${escape(p.title)}" maxlength="500" required></label><div class="field-pair"><label>Brand<input name="brand" value="${escape(p.brand)}" maxlength="500"></label><label>Product type<input name="productType" value="${escape(p.productType)}" maxlength="500"></label></div><label>Description <span class="muted small">Basic HTML supported</span><textarea name="description" rows="6" maxlength="30000">${escape(p.description)}</textarea></label></div><div class="editor-section"><h3>Product images <span class="muted">${p.images.length}</span></h3><p class="muted small">Uncheck images to leave them out of exports.</p><div class="image-grid">${p.images.map((image,i) => `<label class="image-choice ${image.validation === 'invalid' ? 'image-invalid' : ''}"><div>${image.validation === 'valid' ? `<img src="${imagePath(item,image.id)}" alt="${escape(image.alt)}" loading="lazy">` : `<span class="image-error">${icon('alert')}Not accessible</span>`}</div><span><input type="checkbox" name="image" value="${image.id}" ${image.included ? 'checked' : ''}> Image ${i+1}</span>${image.error ? `<small>${escape(image.error)}</small>` : ''}</label>`).join('') || '<p class="muted">No gallery images found.</p>'}</div></div><div class="editor-section"><h3>Collected sizes <span class="muted">${p.variants.length}</span></h3><p class="muted small">Shopify inventory tracking is enabled for every size. Retailer availability does not set your stock quantities.</p><div class="variant-table"><table><thead><tr><th>Size</th><th>Color</th><th>SKU</th><th>Quantity</th><th>Retailer availability</th></tr></thead><tbody>${p.variants.map(v=>`<tr><td>${escape(v.size || '—')}</td><td>${escape(v.color || '—')}</td><td>${escape(v.sku || '—')}</td><td>${v.requestedQuantity ?? 0}</td><td><span class="availability ${v.availability}">${v.availability === 'sold_out' ? 'Sold out' : v.availability === 'available' ? 'Available' : 'Unknown'}</span></td></tr>`).join('') || '<tr><td colspan="5">Sizes are unverified. Retry in browser before CSV export.</td></tr>'}</tbody></table></div></div><p class="source-detail">Source code: ${escape(p.productCode || p.sourceId)} · Collected ${new Date(p.extractedAt).toLocaleString()}</p>`;
  if (p.requestedSelection) { const note = document.createElement("p"); note.className = "error-detail"; note.textContent = `Requested: ${p.requestedSelection.notes.join(" · ")}. Each size occurrence is one unit for inventory. ${p.selectionErrors?.join(" ") || ""}`; document.querySelector("#editor-content")!.prepend(note); }
  const vendorField = document.createElement('label');
  vendorField.innerHTML = `Shopify vendor<input value="${escape(RETAILER_VENDORS[p.retailer])}" readonly><span class="muted small">Set from the source retailer. The product brand is kept separately.</span>`;
  document.querySelector('#editor-content .field-pair')!.before(vendorField);
  const descriptionField = document.querySelector<HTMLTextAreaElement>('#editor-content textarea[name="description"]')!.closest('label')!;
  const descriptionPreview = document.createElement('section');
  descriptionPreview.className = 'description-preview';
  descriptionPreview.innerHTML = `<h3>Product Details from the site</h3><div class="description-body">${p.description || '<p>No description found.</p>'}</div>`;
  const sourceEditor = document.createElement('details');
  sourceEditor.className = 'description-editor';
  sourceEditor.innerHTML = '<summary>Edit description</summary>';
  descriptionField.replaceWith(descriptionPreview, sourceEditor);
  sourceEditor.append(descriptionField);
  dialog.showModal();
}
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
document.querySelector('#edit-form')!.addEventListener('submit', async event => {
  event.preventDefault(); if (!batch || !editedId) return;
  const form = event.target as HTMLFormElement; const data = new FormData(form);
  const p = batch.items.find(i => i.id === editedId)!.product!;
  const picked = new Set(data.getAll('image'));
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!; submit.disabled = true;
  try {
    await mutate(`/batches/${batch.id}/items/${editedId}`, { title: data.get('title'), brand: data.get('brand'), productType: data.get('productType'), description: data.get('description'), images: p.images.map(i => ({ id:i.id, included:picked.has(i.id) })) }, 'PATCH');
    dialog.close(); toast('Changes saved. Your exports will use these details.');
  } catch (e) { document.querySelector('#edit-error')!.textContent = (e as Error).message; }
  finally { submit.disabled = false; }
});
document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach(button => button.addEventListener('click', async () => {
  if (!batch) return; downloading = true; render();
  const format = button.dataset.export!;
  toast(format === 'zip' ? 'Preparing images. Large collections can take a few minutes.' : 'Preparing your export…');
  try {
    const location = document.querySelector<HTMLInputElement>('#inventory-location')!.value;
    const query = format === 'inventory' ? `?location=${encodeURIComponent(location)}` : '';
    const response = await fetch(`/api/batches/${batch.id}/export/${format}${query}`, { headers: { 'X-Session-Token': token } });
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = format === 'csv' ? 'shopify-products.csv' : format === 'inventory' ? 'shopify-inventory.csv' : format === 'zip' ? 'product-images.zip' : 'products.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(format === 'zip' ? 'Image ZIP downloaded. Check manifest.json for any image failures.' : format === 'inventory' ? 'Inventory CSV downloaded. Import it under Shopify Products → Inventory after importing the products.' : `${format.toUpperCase()} downloaded.`);
  } catch (e) { toast((e as Error).message, true); }
  finally { downloading = false; render(); }
}));
async function poll() {
  if (batch && token && !busy && !dialog.open && !htmlDialog.open && batch.running) {
    const id = batch.id; const version = revision;
    try {
      const latest = await request<Batch>(`/batches/${id}`);
      if (batch?.id === id && revision === version && !busy && !dialog.open && !htmlDialog.open) { batch = latest; render(); }
    }
    catch (e) { toast(`Connection interrupted: ${(e as Error).message}`, true); }
  }
  if (cloudMode && token && batch?.running && !busy) void processCloud();
  setTimeout(poll, cloudMode ? 2500 : 1500);
}
async function processCloud() {
  if (processing || !batch?.running || !token) return;
  processing = true;
  try { await request(`/batches/${batch.id}/process`, { method: 'POST' }); processErrorShown = false; }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) showLogin();
    if (!processErrorShown) { toast(`Processing paused: ${(error as Error).message}`, true); processErrorShown = true; }
  } finally { processing = false; }
}
document.querySelector('#login-form')!.addEventListener('submit', async event => {
  event.preventDefault();
  if (loginButton.disabled) return;
  loginButton.disabled = true; loginButton.textContent = 'Signing in…'; loginForm.setAttribute('aria-busy', 'true');
  document.querySelector('#login-error')!.textContent = '';
  try {
    const session = await request<SessionInfo>('/login', { method: 'POST', body: JSON.stringify({ password: passwordInput.value }) });
    passwordInput.value = ''; setPasswordVisible(false); await acceptSession(session);
  } catch (error) { document.querySelector('#login-error')!.textContent = (error as Error).message; passwordInput.focus(); }
  finally { loginButton.disabled = false; loginButton.innerHTML = `Sign in ${icon('arrow')}`; loginForm.removeAttribute('aria-busy'); }
});
function setPasswordVisible(visible: boolean) {
  passwordInput.type = visible ? 'text' : 'password';
  const toggle = document.querySelector<HTMLButtonElement>('#toggle-password')!;
  toggle.textContent = visible ? 'Hide' : 'Show';
  toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  toggle.setAttribute('aria-pressed', String(visible));
}
document.querySelector('#toggle-password')!.addEventListener('click', () => setPasswordVisible(passwordInput.type === 'password'));
passwordInput.addEventListener('input', () => { document.querySelector('#login-error')!.textContent = ''; });
signOutButton.addEventListener('click', async () => {
  signOutButton.disabled = true; signOutButton.textContent = 'Signing out…';
  try {
    await request('/logout', { method: 'POST' });
    sessionStorage.removeItem('collector-batch');
    window.location.reload();
  } catch (error) { toast((error as Error).message, true); signOutButton.disabled = false; signOutButton.textContent = 'Sign out'; }
});
retryConnection.addEventListener('click', () => { void init(); });
document.querySelector('#html-close')!.addEventListener('click', () => { if (!busy) htmlDialog.close(); });
document.querySelector('#html-form')!.addEventListener('submit', async event => {
  event.preventDefault(); if (!batch || !uploadItemId) return;
  const button = document.querySelector<HTMLButtonElement>('#html-form [type="submit"]')!; button.disabled = true;
  const error = document.querySelector('#html-error')!; error.textContent = '';
  try {
    const file = document.querySelector<HTMLInputElement>('#html-file')!.files?.[0];
    if (!file || file.size > 2 * 1024 * 1024) throw new Error('Choose an HTML file up to 2 MB.');
    await mutate(`/batches/${batch.id}/items/${uploadItemId}/html`, {
      html: await file.text(), sourceUrl: document.querySelector<HTMLInputElement>('#html-source-url')!.value,
    });
    htmlDialog.close(); toast('Saved page processed. Review the product details and any notes.');
  } catch (failure) { error.textContent = (failure as Error).message; }
  finally { button.disabled = false; }
});
async function init() {
  connectionState.hidden = false; connectionState.textContent = 'Checking your session…';
  retryConnection.hidden = true; loginForm.hidden = true;
  try {
    const response = await fetch('/api/session');
    if (response.status === 401 && response.headers.get('content-type')?.includes('application/json') && (await response.clone().json()).loginRequired) showLogin();
    else await acceptSession(await readApiJson<SessionInfo>(response));
  } catch (error) {
    token = '';
    document.querySelector<HTMLButtonElement>('#collect')!.disabled = true;
    const message = `Could not connect to the backend. ${error instanceof Error ? error.message : 'Check the server and refresh.'}`;
    workspace.hidden = true; loginScreen.hidden = false;
    connectionState.hidden = false; connectionState.textContent = message;
    retryConnection.hidden = false;
  }
}
void init();
void poll();
