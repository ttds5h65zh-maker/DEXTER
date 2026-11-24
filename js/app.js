// Perlée en lumière: app shell.
// Screens, camera lifecycle, controls and the per-frame tracking loop.
// Privacy: the camera starts only from a tap, frames never leave the device,
// nothing is stored, and the stream is stopped when you leave or hide the tab.

import { METALS, STYLES } from './jewellery.js';
import { loadTracker, detect, delegateUsed } from './tracker.js';

const $ = (sel) => document.querySelector(sel);
const DEBUG = new URLSearchParams(location.search).has('debug');

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  screen: 'landing',
  piece: 'ring',             // 'ring' | 'bracelet' | 'both'
  fingers: new Set(['ring']),
  styles: ['signature'],     // up to 3 designs, stacked in this order
  metal: 'yellow',           // 'yellow' | 'rose' | 'white' | 'mix'
  facing: 'environment',     // rear camera by default
  mirror: false,
};

let stream = null;
let overlay = null;          // created on first try-on (needs WebGL)
let browser = null;          // created on first browse
let trackerReady = false;
let running = false;
let lastVideoTime = -1;
let lastHandSeen = 0;
let wakeLock = null;

// ---------------------------------------------------------------------------
// In-app browsers (WhatsApp, Instagram, LinkedIn, Snapchat, Facebook…) usually
// block the camera, so we ask people to open the page in Safari or Chrome.
// ---------------------------------------------------------------------------
const UA = navigator.userAgent || '';
const IN_APP = /WhatsApp|Instagram|LinkedInApp|Snapchat|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger|TikTok|musical_ly|BytedanceWebview/i.test(UA);
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function show(screen, { push = true } = {}) {
  if (state.screen === screen) return;
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('is-active', el.id === screen));
  const prev = state.screen;
  state.screen = screen;

  if (prev === 'tryon') stopTryOn();
  if (prev === 'browse' && browser) browser.stop();
  closeSheets();
  syncHeart();

  // Let the phone's back button return to the landing screen instead of leaving the site.
  if (push && screen !== 'landing') history.pushState({ screen }, '');
}

window.addEventListener('popstate', () => show('landing', { push: false }));

function goHome() {
  if (history.state && history.state.screen) history.back();
  else show('landing', { push: false });
}

// ---------------------------------------------------------------------------
// Notice dialog + toast
// ---------------------------------------------------------------------------
function showNotice({ title, text, primary, secondary }) {
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  const p = $('#notice-primary');
  const s = $('#notice-secondary');
  p.textContent = primary.label;
  p.onclick = primary.action;
  s.hidden = !secondary;
  if (secondary) {
    s.textContent = secondary.label;
    s.onclick = secondary.action;
  }
  $('#notice').hidden = false;
}
function hideNotice() { $('#notice').hidden = true; }

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

async function copyLink() {
  const url = location.origin + location.pathname;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Older in-app browsers: fall back to a hidden text field.
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast('Link copied. Paste it in Safari or Chrome');
}

function showInAppNotice() {
  showNotice({
    title: 'Open this page in Safari or Chrome',
    text: 'This in-app browser can’t use the camera. Tap the ··· or share menu and choose “Open in browser”, or copy the link and paste it into Safari or Chrome.',
    primary: { label: 'Copy link', action: copyLink },
    secondary: { label: 'Browse without camera', action: () => { hideNotice(); openBrowse(); } },
  });
}

function showCameraError(err) {
  const name = err && err.name;
  let title = 'The camera could not start';
  let text = 'Please try again. You can also browse the pieces in 3D without the camera.';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    title = 'Camera access is off';
    text = 'To try on the pieces, allow camera access for this page in your browser settings, then tap Try again.';
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    title = 'No camera found';
    text = 'This device doesn’t seem to have a camera available. You can still browse the pieces in 3D.';
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    title = 'The camera is busy';
    text = 'Another app may be using the camera. Close it, then tap Try again.';
  }
  showNotice({
    title, text,
    primary: { label: 'Try again', action: () => { hideNotice(); startTryOn(); } },
    secondary: { label: 'Browse without camera', action: () => { hideNotice(); openBrowse(); } },
  });
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const video = $('#video');

async function startCamera(facing) {
  stopCamera();
  const s = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  });
  stream = s;
  video.srcObject = s;
  await video.play().catch(() => {});

  // Mirror the front camera (like a mirror). Laptops report no facing mode: mirror those too.
  const settings = s.getVideoTracks()[0]?.getSettings?.() || {};
  state.facing = settings.facingMode || facing;
  state.mirror = settings.facingMode ? settings.facingMode === 'user' : (facing === 'user' || !IS_MOBILE);
  video.classList.toggle('mirrored', state.mirror);
  lastVideoTime = -1;
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

async function updateFlipButton() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    $('#flip-btn').hidden = cams.length < 2;
  } catch { /* keep the button */ }
}

// ---------------------------------------------------------------------------
// Try-on
// ---------------------------------------------------------------------------
async function startTryOn() {
  if (IN_APP) { showInAppNotice(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // Either an in-app browser or a non-HTTPS address.
    showInAppNotice();
    return;
  }

  show('tryon');
  $('#resume').hidden = true;
  $('#hint').hidden = true;

  // Ask for the camera straight away so it stays tied to the user's tap (iOS).
  const cameraPromise = startCamera(state.facing);
  $('#loader').hidden = trackerReady;

  try {
    await cameraPromise;
  } catch (err) {
    console.warn('[Perlée] camera error', err);
    if (state.screen === 'tryon') goHome();
    showCameraError(err);
    return;
  }
  if (state.screen !== 'tryon') { stopCamera(); return; }
  updateFlipButton();
  requestWakeLock();

  try {
    await ensureOverlay();
    await loadTracker();
    trackerReady = true;
  } catch (err) {
    console.error(err);
    $('#loader').hidden = true;
    showNotice({
      title: 'Hand tracking could not start',
      text: 'This browser could not run the try-on. Please try the latest Safari or Chrome. You can still browse the pieces in 3D.',
      primary: { label: 'Browse without camera', action: () => { hideNotice(); openBrowse(); } },
    });
    return;
  }
  if (state.screen !== 'tryon') return;
  $('#loader').hidden = true;
  lastHandSeen = 0;
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
}

function stopTryOn() {
  running = false;
  stopCamera();
  releaseWakeLock();
  if (overlay) overlay.hideAll();
  $('#hint').hidden = true;
}

async function ensureOverlay() {
  if (overlay) return overlay;
  const { Overlay, TUNING } = await import('./overlay.js');
  overlay = new Overlay($('#overlay'));
  await overlay.init();
  overlay.setSelection({ piece: state.piece, fingers: state.fingers, styles: state.styles, metal: state.metal });
  if (DEBUG) window.perlee = { overlay, TUNING };
  return overlay;
}

// --- Per-frame loop ---------------------------------------------------------
let fpsFrames = 0, fpsStart = 0;

function loop(now) {
  if (!running) return;
  requestAnimationFrame(loop);
  if (video.readyState < 2 || !trackerReady) return;

  // Only run detection when the camera has delivered a new frame.
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const hand = detect(video, now);
  overlay.update(hand, video, state.mirror, now);
  overlay.render();
  updateHint(hand, now);

  if (DEBUG) {
    fpsFrames++;
    if (now - fpsStart > 1000) {
      const el = $('#fps');
      el.hidden = false;
      el.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsStart))} fps · ${delegateUsed}\n${video.videoWidth}×${video.videoHeight}`;
      fpsFrames = 0;
      fpsStart = now;
    }
  }
}

// The calm hint appears after a short moment without a hand (no flicker on brief losses).
function updateHint(hand, now) {
  if (hand) lastHandSeen = now;
  const hidden = !!hand || (lastHandSeen && now - lastHandSeen < 600);
  const el = $('#hint');
  if (el.hidden !== hidden) el.hidden = hidden;
}

// Keep the screen awake while someone is trying the pieces on.
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

// Stop the camera whenever the page is hidden (tab switch, phone locked).
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.screen === 'tryon' && stream) {
    running = false;
    stopCamera();
    releaseWakeLock();
    overlay?.hideAll();
    $('#hint').hidden = true;
    $('#resume').hidden = false;
  }
  if (document.hidden && browser) browser.stop();
  if (!document.hidden && state.screen === 'browse' && browser) browser.start();
});
window.addEventListener('pagehide', () => stopCamera());

// ---------------------------------------------------------------------------
// Browse without camera
// ---------------------------------------------------------------------------
async function openBrowse() {
  show('browse');
  if (!browser) {
    const { BrowseViewer } = await import('./browse.js');
    browser = new BrowseViewer($('#browse-canvas'));
  }
  browser.setLook({ styles: state.styles, metal: state.metal });
  if (state.screen === 'browse') browser.start();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function buildSwatches() {
  document.querySelectorAll('[data-group="metal"]').forEach((group) => {
    group.innerHTML = '';
    for (const [key, metal] of Object.entries(METALS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = key;
      b.setAttribute('aria-pressed', String(key === state.metal));
      b.setAttribute('aria-label', metal.label);
      b.innerHTML = `<i class="swatch-${key}"></i><span>${metal.short}</span>`;
      group.appendChild(b);
    }
  });
}

function buildDesigns() {
  document.querySelectorAll('[data-group="styles"]').forEach((group) => {
    group.innerHTML = '';
    for (const [key, style] of Object.entries(STYLES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = key;
      b.textContent = style.label;
      group.appendChild(b);
    }
  });
}

function syncControls() {
  document.querySelectorAll('[data-group="piece"] button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.value === state.piece)));
  document.querySelectorAll('[data-group="fingers"] button').forEach((b) =>
    b.setAttribute('aria-pressed', String(state.fingers.has(b.dataset.value))));
  document.querySelectorAll('[data-group="metal"] button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.value === state.metal)));
  document.querySelectorAll('[data-group="styles"]').forEach((group) => {
    group.classList.toggle('is-stacked', state.styles.length > 1);
    group.querySelectorAll('button').forEach((b) => {
      const i = state.styles.indexOf(b.dataset.value);
      b.setAttribute('aria-pressed', String(i >= 0));
      b.dataset.order = i >= 0 ? i + 1 : '';
    });
  });
  $('#browse-names').textContent = state.styles.map((k) => STYLES[k].label).join('  ·  ');
  $('[data-group="fingers"]').classList.toggle('is-disabled', state.piece === 'bracelet');
  overlay?.setSelection({ piece: state.piece, fingers: state.fingers, styles: state.styles, metal: state.metal });
  browser?.setLook({ styles: state.styles, metal: state.metal });
  syncHeart();
}

// ---------------------------------------------------------------------------
// My shortlist + boutique visit (demo only).
// Looks are kept in memory on this screen only: nothing is stored or sent,
// and the list is gone when the page is closed.
// ---------------------------------------------------------------------------
const FINGER_ORDER = ['index', 'middle', 'ring', 'little'];
const shortlist = [];

function currentLook() {
  const styles = [...state.styles];
  if (state.screen === 'browse') return { piece: 'both', fingers: [], styles, metal: state.metal };
  const fingers = state.piece === 'bracelet' ? [] : FINGER_ORDER.filter((f) => state.fingers.has(f));
  return { piece: state.piece, fingers, styles, metal: state.metal };
}
const lookKey = (l) => `${l.piece}|${l.fingers.join(',')}|${l.styles.join('+')}|${l.metal}`;

function listWords(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} & ${words[words.length - 1]}`;
}

function describeLook(l) {
  const labels = l.styles.map((k) => STYLES[k].label);
  const stacked = labels.length > 1;
  const one = labels[0];
  const name = l.piece === 'bracelet' ? (stacked ? 'Bangle stack' : `${one} bangle`)
    : l.piece === 'ring' ? (stacked ? 'Ring stack' : `${one} ring${l.fingers.length > 1 ? 's' : ''}`)
    : (stacked ? 'Ring & bangle stack' : `${one} ring & bangle`);
  let detail = (stacked ? `${labels.join(' + ')} · ` : '') + METALS[l.metal].label;
  if (l.fingers.length) {
    const f = listWords(l.fingers);
    detail += ` · ${f.charAt(0).toUpperCase() + f.slice(1)} finger${l.fingers.length > 1 ? 's' : ''}`;
  }
  return { name, detail };
}

function syncHeart() {
  const saved = shortlist.some((l) => lookKey(l) === lookKey(currentLook()));
  document.querySelectorAll('.heart-btn').forEach((b) => b.setAttribute('aria-pressed', String(saved)));
  document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = shortlist.length; });
}

function toggleLook(btn) {
  const look = currentLook();
  const i = shortlist.findIndex((l) => lookKey(l) === lookKey(look));
  if (i >= 0) {
    shortlist.splice(i, 1);
    toast('Removed from My shortlist');
  } else {
    shortlist.push(look);
    toast('Saved to My shortlist');
    btn.classList.remove('pop');
    void btn.offsetWidth; // restart the little "pop" animation
    btn.classList.add('pop');
  }
  syncHeart();
}

function renderShortlist() {
  const list = $('#look-list');
  list.innerHTML = '';
  for (const look of shortlist) {
    const { name, detail } = describeLook(look);
    const li = document.createElement('li');
    li.innerHTML = `<i class="look-swatch swatch-${look.metal}"></i>
      <span class="look-text"><span class="look-name"></span><span class="look-detail"></span></span>
      <button class="look-remove" type="button" data-action="remove-look" aria-label="Remove">×</button>`;
    li.querySelector('.look-name').textContent = name;
    li.querySelector('.look-detail').textContent = detail;
    li.querySelector('.look-remove').dataset.key = lookKey(look);
    list.appendChild(li);
  }
  $('#shortlist-empty').hidden = shortlist.length > 0;
}

function openSheet(id) {
  closeSheets();
  $(id).hidden = false;
}
function closeSheets() {
  $('#shortlist-sheet').hidden = true;
  $('#booking-sheet').hidden = true;
}

function openBooking() {
  $('#booking-text').textContent =
    'In the live experience, your shortlist goes to a boutique advisor who prepares these pieces for your visit.';
  $('#advisor-btn').hidden = false;
  openSheet('#booking-sheet');
}

function speakToAdvisor() {
  $('#booking-text').textContent =
    'Thank you. In the live experience, an advisor would now reach out to arrange your visit. This is a demo, so nothing has been sent.';
  $('#advisor-btn').hidden = true;
}

// Tapping the dimmed background closes a sheet.
['#shortlist-sheet', '#booking-sheet'].forEach((id) => {
  $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSheets(); });
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const group = btn.parentElement?.dataset.group;

  if (group === 'piece') {
    state.piece = btn.dataset.value;
  } else if (group === 'fingers') {
    const f = btn.dataset.value;
    if (state.fingers.has(f)) {
      if (state.fingers.size === 1) { toast('Keep at least one finger'); return; }
      state.fingers.delete(f);
    } else {
      state.fingers.add(f);
    }
  } else if (group === 'styles') {
    const k = btn.dataset.value;
    const i = state.styles.indexOf(k);
    if (i >= 0) {
      if (state.styles.length === 1) { toast('Keep at least one design'); return; }
      state.styles.splice(i, 1);
    } else {
      if (state.styles.length === 3) { toast('Stack up to 3 designs'); return; }
      state.styles.push(k);
    }
  } else if (group === 'metal') {
    state.metal = btn.dataset.value;
  } else {
    const action = btn.dataset.action;
    if (action === 'home') goHome();
    if (action === 'copy-link') copyLink();
    if (action === 'resume') startTryOn();
    if (action === 'save-look') toggleLook(btn);
    if (action === 'open-shortlist') { renderShortlist(); openSheet('#shortlist-sheet'); }
    if (action === 'remove-look') {
      const i = shortlist.findIndex((l) => lookKey(l) === btn.dataset.key);
      if (i >= 0) shortlist.splice(i, 1);
      renderShortlist();
      syncHeart();
    }
    if (action === 'book-visit') openBooking();
    if (action === 'speak-advisor') speakToAdvisor();
    if (action === 'close-sheet') closeSheets();
    return;
  }
  syncControls();
});

$('#start-btn').addEventListener('click', startTryOn);
$('#browse-btn').addEventListener('click', openBrowse);
$('#flip-btn').addEventListener('click', async () => {
  const next = state.facing === 'user' ? 'environment' : 'user';
  try {
    overlay?.hideAll();
    await startCamera(next);
    if (state.facing !== next) toast('Only one camera is available');
  } catch (err) {
    console.warn(err);
    toast('Could not switch camera');
    startCamera(state.facing).catch(showCameraError);
  }
});

// ---------------------------------------------------------------------------
// Boot: show the landing screen at once, then warm up the model in the background.
// ---------------------------------------------------------------------------
buildSwatches();
buildDesigns();
syncControls();
history.replaceState(null, '');
if (IN_APP) $('#inapp-banner').hidden = false;

const warmUp = () => {
  loadTracker().then(() => { trackerReady = true; }).catch((e) => console.warn('[Perlée] preload failed', e));
};
if ('requestIdleCallback' in window) requestIdleCallback(warmUp, { timeout: 1200 });
else setTimeout(warmUp, 400);
