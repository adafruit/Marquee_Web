/**
 * A1 — your displays.
 *
 * Home, and the only screen that is about more than one device. Everything else in the
 * app is written against whichever record is active; this is where that changes.
 *
 * Two states in one screen. With devices it is a grid of tiles plus a dashed add slot;
 * with none it is the add slot alone. There is no separate empty-state screen because
 * there is nothing separate to say — the grid already contains the one action, and an
 * onboarding panel that appears and then never appears again is a screen most users
 * see exactly once.
 *
 * Tiles show what is on the panel rather than a device name and a status, which is what
 * makes the list read like a wall of little screens. The picture comes from the cache
 * a8.js writes on every confirmed draw — and, for every display this browser has never
 * watched draw, from that display's own bitmap feed, read here (see sweepThumbs). The
 * cache alone left most of the wall saying "Nothing drawn yet" about boards with a
 * perfectly good picture published to them.
 */

import { activateDevice, removeDevice } from '../device/activate.js';
import { feedKeyIn } from '../core/api.js';
import { readFeedLast } from '../device/feeds.js';
import { deviceEntry, navigate, currentScreen } from '../core/router.js';
import { DISPLAY_PRESETS } from '../device/presets.js';
import { readPanelCache, writePanelCache } from './a8.js';
import * as devices from '../device/devices.js';
import { $, val, escapeHtml, escapeAttr, fmtAgo, fmtClock, toast } from '../core/util.js';

/**
 * What a tile can say about a device without activating it.
 *
 * Everything here comes off the stored record. That is the constraint that makes the
 * grid cheap — rendering N tiles must not mean hydrating N boards — and it is why the
 * record carries `flow` and `displayConfig` snapshots rather than pointers.
 */
function tileFacts(rec) {
  const flow = rec.flow || {};
  const preset = flow.selectedPanel ? DISPLAY_PRESETS[flow.selectedPanel] : null;
  const asleep = flow.deviceState === 'asleep';
  const wakesIn = asleep && flow.wakesAt && flow.wakeSource !== 'pin'
    ? Math.max(0, Math.round((flow.wakesAt - Date.now()) / 1000))
    : null;

  return {
    label: devices.deviceLabel(rec),
    hardware: preset?.spec || 'Panel set up by hand',
    group: (rec.settings?.ioGroup || '').trim(),
    // "On air" needs evidence, not an absence of it. A board that has never been
    // written to is neither — it reads as the neutral pill with no time beside it.
    live: !asleep && !!flow.lastWriteAt,
    asleep,
    when: wakesIn != null ? `wakes in ${fmtClock(wakesIn)}` : (flow.lastWriteAt ? `refreshed ${fmtAgo(flow.lastWriteAt)}` : ''),
  };
}

/** This display's bitmap feed, derived from its own record — no activation involved. */
function bitmapFeedFor(rec) {
  return feedKeyIn(rec.settings?.ioGroup, 'bitmap');
}

/** The last panel image cached for this display, if there is one. a8.js owns the
 *  format; this screen is the other end of it. */
function thumbFor(rec) {
  return readPanelCache(rec.id, bitmapFeedFor(rec) || null)?.src || null;
}

function pillHTML(f) {
  if (f.live) {
    return '<span class="pill pill-on-air"><span class="dot"></span>On air</span>';
  }
  return `<span class="pill pill-asleep"><span class="dot"></span>${f.asleep ? 'Asleep' : 'Idle'}</span>`;
}

/**
 * A device tile: the picture, what the record knows, and a way out.
 *
 * The card cannot be one big button any more — Remove lives inside it, and a control
 * inside a control is neither valid markup nor reachable by keyboard. So the opening
 * action is an empty button STRETCHED OVER the card (see .card-open), leaving the
 * picture and the meta as direct children of the card exactly as they were when the
 * card itself was the button. Wrapping them in the button instead was tried first and
 * is what cropped every thumbnail: it put a flex container between the card and the
 * preview box for a control that draws nothing.
 */
function deviceTileHTML(rec) {
  const f = tileFacts(rec);
  const src = thumbFor(rec);
  const glass = src
    ? `<img class="thumb-img" src="${escapeAttr(src)}" alt="">`
    : '<span class="thumb-empty">Nothing drawn yet</span>';

  return `<div class="device-card card blueprint" data-device="${escapeAttr(rec.id)}">
    <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
    <button type="button" class="card-open" aria-label="Open ${escapeAttr(f.label)}"></button>
    <span class="thumb">${glass}</span>
    <span class="meta">
      <span class="row">${pillHTML(f)}<span class="when">${escapeHtml(f.when)}</span></span>
      <span class="name">${escapeHtml(f.label)}</span>
      <span class="hardware">${escapeHtml(f.hardware)}</span>
      ${f.group ? `<span class="group mono">${escapeHtml(f.group)}</span>` : ''}
    </span>
    <button type="button" class="btn btn-sm btn-ghost card-remove" data-remove="${escapeAttr(rec.id)}"
      aria-label="Remove ${escapeAttr(f.label)}">Remove</button>
  </div>`;
}

/**
 * A draft gets a tile of its own rather than being hidden.
 *
 * Only reached once something has been entered — devices.js discards an untouched draft
 * on the way in here. Past that point, quietly dropping a half-configured board because
 * the user clicked away is worse than showing an unfinished one and letting them decide.
 */
function draftTileHTML(rec) {
  const label = devices.deviceLabel(rec);
  const named = label !== 'Untitled display';
  return `<div class="device-card card blueprint is-draft" data-draft="true">
    <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
    <button type="button" class="card-open" data-resume="${escapeAttr(rec.id)}"
      aria-label="Resume setup for ${escapeAttr(named ? label : 'this display')}"></button>
    <span class="thumb"><span class="thumb-empty">Setup unfinished</span></span>
    <span class="meta">
      <span class="row"><span class="tag tag-outline">In setup</span></span>
      <span class="name">${escapeHtml(named ? label : 'New display')}</span>
      <span class="hardware">Pick up where you left off</span>
    </span>
    <button type="button" class="btn btn-sm btn-ghost card-remove" data-discard="${escapeAttr(rec.id)}">Discard</button>
  </div>`;
}

const ADD_TILE_HTML = `<button type="button" class="add-tile blueprint" id="a1Add">
    <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
    <span class="plus">+</span>
    <span class="cap">Add a new marquee display</span>
    <span class="sub">Let's get started!</span>
  </button>`;

// ---------- filling the empty tiles -----------------------------------------
//
// The cache a8.js writes only covers displays THIS browser has watched draw. Every
// other tile said "Nothing drawn yet" about a board with a perfectly good picture
// sitting on its bitmap feed — the one thing on this screen that is knowable without
// activating anything, since a record carries its own group key.
//
// So the grid paints from cache immediately and then asks IO, one display at a time.
// Sequential is deliberate: these are ~20 KB base64 payloads each and every read counts
// against an account-wide rate limit shared with every feed-bound element on the canvas.

/** How long a sweep is good for. Bouncing into a display and straight back out must not
 *  re-read every feed; a minute later, it is worth asking again. */
const SWEEP_TTL_MS = 60000;

let lastSweepAt = 0;

/** Bumped by every render() and every sweep, so a sweep that is still walking the list
 *  when the grid is rebuilt underneath it stops rather than painting into stale tiles. */
let sweepRun = 0;

function thumbSlot(id) {
  return $('a1Grid')?.querySelector(`[data-device="${CSS.escape(id)}"] .thumb`) || null;
}

function paintThumb(id, src) {
  const slot = thumbSlot(id);
  if (slot) slot.innerHTML = `<img class="thumb-img" src="${escapeAttr(src)}" alt="">`;
}

function paintThumbNote(id, text) {
  const slot = thumbSlot(id);
  if (slot) slot.innerHTML = `<span class="thumb-empty">${escapeHtml(text)}</span>`;
}

/**
 * Fill in what the tiles could not know, from each display's own bitmap feed.
 *
 * What lands in the cache is the NEWEST datum on the feed, which is very nearly always
 * the picture on the glass: on a history-off feed there is only ever one, and the board
 * redraws whatever is there on its next wake. It can be a take published minutes ago and
 * not yet collected — A8 is the screen that draws that distinction, and it has the wake
 * bracket to draw it with. A wall of thumbnails does not, and "the picture this display
 * is carrying" is the honest reading of it either way.
 *
 * Every failure is silent. A missing feed, no credentials, a network that is down — the
 * tile keeps saying nothing was drawn, which is exactly as much as we know.
 */
async function sweepThumbs() {
  const run = ++sweepRun;
  if (!val('ioUser') || !val('ioKey')) return;
  // The TTL governs RE-reading a tile that already has a picture. A tile with none is
  // asked about every time: it is the empty tile this whole sweep exists for, and
  // leaving it empty for a minute because of a sweep that happened before its display
  // was added would be the same bug in a smaller window.
  const stale = Date.now() - lastSweepAt >= SWEEP_TTL_MS;
  lastSweepAt = Date.now();

  for (const rec of devices.listDevices()) {
    // The grid was rebuilt, or the user left. Either way the tiles this was painting
    // into are gone.
    if (run !== sweepRun || currentScreen() !== 'a1') return;
    const feed = bitmapFeedFor(rec);
    if (!feed) continue;

    const known = !!thumbFor(rec);
    if (known && !stale) continue;
    if (!known) paintThumbNote(rec.id, 'Reading the feed…');
    const d = await readFeedLast(feed);
    if (run !== sweepRun) return;
    if (!d) {
      if (!known) paintThumbNote(rec.id, 'Nothing drawn yet');
      continue;
    }
    const take = {
      src: `data:image/bmp;base64,${String(d.value || '').replace(/\s+/g, '')}`,
      at: d.createdAt,
    };
    writePanelCache(rec.id, feed, take);
    paintThumb(rec.id, take.src);
  }
}

function render() {
  sweepRun++;   // whatever a sweep was painting into is about to be replaced
  const list = devices.listDevices();
  const draft = devices.getDraft();

  const live = list.filter((r) => r.flow?.deviceState !== 'asleep' && r.flow?.lastWriteAt).length;
  $('a1Count').textContent = list.length
    ? `${list.length} display${list.length === 1 ? '' : 's'} · ${live} on air right now`
    : 'No displays yet';

  $('a1Grid').innerHTML = [
    ...list.map(deviceTileHTML),
    draft ? draftTileHTML(draft) : '',
    ADD_TILE_HTML,
  ].join('');
}

/**
 * What removing a display actually costs, said before it happens.
 *
 * Named rather than inlined because it is the one thing on this screen that cannot be
 * undone, and because the second paragraph is the part that matters: this is a browser
 * bookmark being torn up, not a board being decommissioned. Nothing on Adafruit IO is
 * touched, so the group, the four feeds and the scene on canvas-state all survive — and
 * the panel keeps drawing whatever was last published to it, on its own, indefinitely.
 *
 * Same wording as "Remove display" in Settings, which is the same action reached from
 * the other end.
 */
function confirmRemoval(rec) {
  const name = devices.deviceLabel(rec);
  return confirm(`Remove "${name}" from this browser?\n\nIts dashboard and settings are `
    + 'deleted here. Nothing on Adafruit IO is touched — the group and its feeds stay, '
    + 'and the board keeps running whatever was last flashed onto it.');
}

export function initA1({ onEnter }) {
  $('a1Grid').addEventListener('click', async (e) => {
    // The two destructive controls come FIRST, both of them. Each sits inside a tile
    // that also opens on click, so a check that ran after the open would never be
    // reached — closest() finds the card from the button just as happily.
    const discard = e.target.closest('[data-discard]');
    if (discard) {
      // No confirm: a draft is a setup that was started and abandoned, the tile says so,
      // and devices.js has already thrown away the ones with nothing in them. Routed
      // through removeDevice() all the same, because a draft is usually the ACTIVE
      // record — see the note there about what a bare delete leaves behind.
      await removeDevice(discard.dataset.discard);
      render();
      return;
    }

    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const rec = devices.getDevice(remove.dataset.remove);
      if (!rec || !confirmRemoval(rec)) return;
      const name = devices.deviceLabel(rec);
      await removeDevice(rec.id);
      render();
      toast(`Removed ${name}`);
      return;
    }

    const resume = e.target.closest('[data-resume]');
    if (resume) {
      const rec = devices.getDevice(resume.dataset.resume);
      await activateDevice(rec.id);
      navigate(deviceEntry(rec));
      return;
    }

    if (e.target.closest('#a1Add')) {
      const rec = devices.createDraft();
      // createDraft() only mints the record; the app still has to be pointed at it, and
      // that means flushing whatever device was active behind this list.
      await activateDevice(rec.id);
      navigate('a4');
      return;
    }

    const card = e.target.closest('[data-device]');
    if (!card) return;
    const rec = devices.getDevice(card.dataset.device);
    if (!rec) return;
    await activateDevice(rec.id);
    navigate(deviceEntry(rec));
  });

  onEnter('a1', () => {
    // Arriving here is the moment an abandoned draft stops being in progress. Only the
    // untouched case is dropped — see discardUntouchedDraft().
    devices.discardUntouchedDraft();
    render();
    // After the paint, never before it: the grid is complete from cache the moment the
    // screen appears, and the feed reads fill in the gaps behind it.
    sweepThumbs();
  });
}
