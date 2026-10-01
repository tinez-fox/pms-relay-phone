// Project Suite on the phone: the relay app's screens.
//
//   sign-in      GitHub through Supabase Auth (auth.js)
//   passphrase   the relay passphrase → keys in IndexedDB (sync.unlock); a wrong one is refused
//   #/inbox      cards from the Mac: pick, comment, images (check cards), clear, hide
//   #/reports    final reports (Q8: runs that failed, ended in Review, or came from the phone), and
//                the phone's own runs still working; #/reports/<runId> reads one
//   #/new        new task, optionally delegated (agent, mode, model, effort), fed by the directory
//   #/outbox     what the phone sent and what the Mac said, plus the connection and sign-out
//
// Everything shown comes from IndexedDB; the relay loop (sync.js) fills it and calls render().
import { CONFIG } from '../config.js';
import { createAuth, AuthError } from './auth.js';
import { createMailbox } from './mailbox.js';
import * as store from './store.js';
import { createSync, unlock, keysNow, forgetKeys, queueCommand, retryCommand, hideCard, dismissReport, cardImagePaths } from './sync.js';
import { downsize } from './images.js';
import { markdown } from './markdown.js';

const POLL_MS = 15000;
const FAST_POLL_MS = 4000;    // while a command waits for its result (the Mac answers within its 15 s poll)
const FAST_FOR_MS = 2 * 60000;
const ONLINE_MS = 35 * 60000; // the Mac re-sends the directory every 30 minutes
const MAX_PHOTOS = 6;
// The only modes a phone run can have (the Mac enforces the same; bypassPermissions never shows here
// even if a directory said so). Labels and hints as on the desktop's Delegate modal.
const MODES = {
  auto: ['Auto', 'Works on its own; a safety check reviews risky actions. Best for most work.'],
  plan: ['Plan only', 'Read-only: investigates and writes a plan, changes nothing.'],
  acceptEdits: ['Edits only', 'Reads and edits files; shell commands that need approval are refused.'],
};
const NEW_ID = 'new'; // the photos map's key for the New form

const $app = document.getElementById('app');
const S = { screen: 'loading', view: 'inbox', report: null, cards: [], reports: [], outbox: [], status: {}, macSeenAt: null, session: null, error: '', busy: false, rekeyed: null, directory: null, update: null };
const drafts = new Map();   // cardId → comment being typed
const picks = new Map();    // cardId → selected option key
const photos = new Map();   // cardId → [{ blob, name, type, w, h }] for Send back
const urls = new Map();     // storage path or photo → object URL
// The New form. Text fields write here as they are typed, so a poll's redraw keeps them; project,
// agent and mode are remembered for next time.
const pref = (() => { try { return JSON.parse(localStorage.getItem('new.pref')) || {}; } catch { return {}; } })();
const form = { projectId: pref.projectId || '', title: '', notes: '', priority: 'normal', delegate: pref.delegate !== false, agent: pref.agent || '', mode: pref.mode || 'auto', model: pref.model || '', effort: pref.effort || '', extra: '' };
let auth, mailbox, sync, timer = null, dirty = false, lastHtml = '';

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ago(t) {
  const ms = Date.now() - (typeof t === 'number' ? t : Date.parse(t));
  if (!(ms >= 0)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
const clock = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const ICONS = {
  github: '<path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" fill="currentColor" stroke="none"/>',
  inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  send: '<path d="M4 12 20 4l-5 16-3.5-6.5z"/><path d="m11.5 13.5 3-3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M4 4v4h4M20 20v-4h-4"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  out: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13v1M15 13v1"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
};
const icon = (n, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;

function urlFor(key, blob) {
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}
async function imageUrls(paths) {
  const out = {};
  for (const p of paths) { const b = await store.blobs.get(p); if (b) out[p] = urlFor(p, b.blob); }
  return out;
}

function toast(text, { action = null } = {}) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="btn sm" data-act="${esc(action.act)}">${esc(action.label)}</button>` : ''}`;
  document.body.append(el);
  if (!action) setTimeout(() => el.remove(), 3200);
}

// ---------- data ----------

async function load() {
  const [cards, reports, outbox, status, macSeenAt, session, rekeyed, directory] = await Promise.all([
    store.cards.all(), store.reports.all(), store.outbox.all(), store.kv.get('status'), store.kv.get('macSeenAt'), store.kv.get('session'), store.kv.get('rekeyed'), store.kv.get('directory'),
  ]);
  Object.assign(S, { cards: cards.sort((a, b) => (a.value.createdAt || '').localeCompare(b.value.createdAt || '') || a.receivedAt - b.receivedAt), reports: reports.sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') || b.receivedAt - a.receivedAt), outbox: outbox.sort((a, b) => b.at - a.at), status: status || {}, macSeenAt, session, rekeyed, directory });
  S.images = await imageUrls(cards.flatMap((c) => cardImagePaths(c.value)));
  // What was typed or picked on a card that has gone (answered, closed on the Mac) goes with it.
  const live = new Set(cards.map((c) => c.cardId));
  for (const m of [drafts, picks]) for (const id of m.keys()) if (!live.has(id)) m.delete(id);
  for (const id of photos.keys()) if (id !== NEW_ID && !live.has(id)) photos.delete(id);
  for (const [k, u] of urls) if (typeof k === 'object' && ![...photos.values()].some((l) => l.includes(k))) { URL.revokeObjectURL(u); urls.delete(k); }
}

async function refresh() { await load(); render(); }

async function syncNow() {
  const r = await sync.run();
  if (r.state === 'rekey') { S.screen = 'passphrase'; S.error = ''; await refresh(); return; }
  if (r.state === 'signin') { await sessionLost(); return; }
  if (r.state === 'not-member') { S.screen = 'passphrase'; S.error = 'not-member'; }
  await refresh();
}

function startPolling() {
  stopPolling();
  const loop = async () => {
    if (document.visibilityState === 'visible') await syncNow().catch((e) => console.error(e));
    if (S.screen !== 'main') return;
    const waiting = S.outbox.some((c) => c.state === 'sent' && Date.now() - c.sentAt < FAST_FOR_MS);
    timer = setTimeout(loop, waiting ? FAST_POLL_MS : POLL_MS);
  };
  loop();
}
function stopPolling() { clearTimeout(timer); timer = null; }

// ---------- render ----------

// A background render would wipe what is being typed: wait until the field loses focus.
function render({ force = false } = {}) {
  const typing = document.activeElement?.matches?.('textarea, select, input[type=text], input[type=password]') && $app.contains(document.activeElement);
  if (typing && !force) { dirty = true; return; }
  dirty = false;
  const html = screen();
  if (html === lastHtml) return; // a poll that changed nothing leaves the page (and its images) alone
  lastHtml = html;
  const focus = document.activeElement?.id;
  $app.innerHTML = html;
  if (focus) document.getElementById(focus)?.focus();
  document.querySelectorAll('textarea[data-draft], textarea[data-field]').forEach(autoGrow);
}
document.addEventListener('focusout', () => setTimeout(() => { if (dirty) render(); }, 0));

function screen() {
  switch (S.screen) {
    case 'loading': return `<div class="center"><div class="spinner"></div></div>`;
    case 'config': return gate('lock', 'Not set up yet', `<p>This copy of the app has no Supabase settings. Put the project URL and the anon key in <code>config.js</code> and publish again.</p>`);
    case 'signin': return signIn();
    case 'passphrase': return passphrase();
    default: return main();
  }
}

function gate(ic, title, body) {
  return `<main class="gate"><div class="gate-mark">${icon(ic, 'i big')}</div><h1>${esc(title)}</h1>${body}</main>`;
}

function signIn() {
  return `<main class="gate">
    <img class="gate-logo" src="icons/icon-192.png" alt="" width="72" height="72">
    <h1>Project Suite</h1>
    <p class="lead">Your Inbox from the work Mac. Cards travel end-to-end encrypted; Supabase only carries ciphertext.</p>
    <button class="btn primary big" data-act="signin" ${S.busy ? 'disabled' : ''}>${icon('github')}Sign in with GitHub</button>
    ${S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : ''}
    <p class="fine">Only the GitHub account set up for the relay gets in. Anyone else sees an empty mailbox.</p>
  </main>`;
}

function passphrase() {
  const who = S.session?.user?.name ? `Signed in as <b>${esc(S.session.user.name)}</b>.` : '';
  const msg = S.error === 'wrong' ? 'That isn’t the relay passphrase. Check the four words and try again.'
    : S.error === 'not-member' ? 'This account isn’t on the relay yet, or the Mac hasn’t run setup. Nothing to unlock.'
    : S.error;
  return `<main class="gate">
    <div class="gate-mark">${icon('lock', 'i big')}</div>
    <h1>${S.rekeyed ? 'New passphrase' : 'Relay passphrase'}</h1>
    <p class="lead">${S.rekeyed ? 'The passphrase was changed on the Mac. Type the new one.' : 'Type the four words <code>relay.mjs setup</code> showed on the Mac. You only do this once on this phone.'}</p>
    <form class="pass-form" data-form="unlock" autocomplete="off">
      <label for="pass">Passphrase</label>
      <input id="pass" name="pass" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="go" placeholder="four words with spaces" ${S.busy ? 'disabled' : ''}>
      <button class="btn primary big" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spinner sm"></span>Checking…' : `${icon('lock')}Unlock`}</button>
    </form>
    ${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}
    <p class="fine">${who} The passphrase is not stored, only the key made from it, and that key can’t be read back out of this phone. <button class="link" data-act="signout">Sign out</button></p>
  </main>`;
}

function connection() {
  const st = S.status;
  const seen = S.macSeenAt;
  if (st.state === 'paused') return { cls: 'bad', text: 'Supabase project paused', tip: 'Restore it in the Supabase dashboard' };
  if (st.state === 'offline' && st.failedAt > (st.lastOkAt || 0)) return { cls: 'warn', text: navigator.onLine === false ? 'No connection' : 'Can’t reach Supabase', tip: st.error || '' };
  if (!seen) return { cls: 'muted', text: 'Waiting for the Mac', tip: '' };
  if (Date.now() - seen < ONLINE_MS) return { cls: 'good', text: `Mac seen ${ago(seen)}`, tip: '' };
  return { cls: 'muted', text: `Mac last seen ${clock(seen)}`, tip: 'Commands wait in the mailbox until it wakes (up to 7 days)' };
}

function main() {
  const conn = connection();
  const inflight = S.outbox.filter((c) => c.state === 'queued' || c.state === 'sent').length;
  const failed = S.outbox.filter((c) => c.state === 'error' && !c.seen).length;
  const title = { inbox: 'Inbox', reports: 'Reports', new: 'New task', outbox: 'Outbox' }[S.view];
  const unread = S.reports.filter((r) => !r.seen).length;
  const views = { inbox: inboxView, reports: reportsView, new: newView, outbox: outboxView };
  return `<header class="top">
      <h1>${title}</h1>
      <button class="conn ${conn.cls}" data-act="sync" aria-label="Sync now">${icon('sync', 'i' + (S.syncing ? ' spin' : ''))}<span>${esc(conn.text)}</span></button>
    </header>
    <main class="page">${views[S.view]()}</main>
    <nav class="tabs">
      <a href="#/inbox" class="${S.view === 'inbox' ? 'on' : ''}">${icon('inbox')}<span>Inbox</span>${S.cards.length ? `<b class="badge">${S.cards.length}</b>` : ''}</a>
      <a href="#/reports" class="${S.view === 'reports' ? 'on' : ''}">${icon('doc')}<span>Reports</span>${unread ? `<b class="badge">${unread}</b>` : ''}</a>
      <a href="#/new" class="${S.view === 'new' ? 'on' : ''}">${icon('plus')}<span>New</span></a>
      <a href="#/outbox" class="${S.view === 'outbox' ? 'on' : ''}">${icon('send')}<span>Outbox</span>${failed ? `<b class="badge bad">${failed}</b>` : inflight ? `<b class="badge quiet">${inflight}</b>` : ''}</a>
    </nav>`;
}

// ---------- inbox ----------

const KIND = {
  decision: { label: 'Pick an option', icon: 'list' },
  check: { label: 'Look at what it made', icon: 'eye' },
  'inbox-ask': { label: 'Question', icon: 'list' },
  'run-failed': { label: 'Run failed', icon: 'alert' },
  blocked: { label: 'Blocked ticket', icon: 'alert' },
};

function inboxView() {
  if (!S.cards.length) {
    return `<div class="empty">${icon('check', 'i big')}<h2>All clear</h2><p>When an agent needs a pick or wants you to look at something, it shows up here. ${S.macSeenAt ? '' : 'Nothing has come from the Mac yet.'}</p></div>`;
  }
  return S.cards.map(cardView).join('');
}

function cardView(c) {
  const v = c.value;
  const k = KIND[v.type] || { label: v.type, icon: 'list' };
  const id = esc(c.cardId);
  const pending = c.pending ? S.outbox.find((o) => o.id === c.pending.cmdId) : null;
  const facts = [
    v.problem && ['Problem', v.problem], v.did && [v.type === 'check' ? 'Made' : 'Did', v.did], v.why && ['Why', v.why],
  ].filter(Boolean);
  return `<article class="card k-${esc(v.type)}${c.pending ? ' is-pending' : ''}" data-card="${id}">
    <div class="card-top">${icon(k.icon)}<span>${esc(k.label)}</span><span class="grow"></span><time>${esc(ago(v.createdAt || c.receivedAt))}</time></div>
    <h2>${esc(v.title)}</h2>
    ${v.projectName || v.taskTitle ? `<div class="where">${v.projectName ? `<span class="chip">${esc(v.projectName)}</span>` : ''}${v.taskTitle ? `<span class="task">${esc(v.taskTitle)}</span>` : ''}</div>` : ''}
    ${facts.length ? `<dl class="facts">${facts.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('')}</dl>` : ''}
    ${v.steps ? `<div class="steps">${esc(v.steps)}</div>` : ''}
    ${body(c)}
    ${c.error ? `<p class="err" role="alert">${icon('alert')}${esc(c.error)}</p>` : ''}
    ${c.pending ? `<div class="pending">${pending?.state === 'queued' ? '<span class="spinner sm"></span>Sending…' : `${icon('send')}Sent: waiting for the Mac`}<span class="muted">${esc(c.pending.label)}</span></div>` : ''}
  </article>`;
}

function body(c) {
  const v = c.value;
  const id = esc(c.cardId);
  const off = c.pending ? 'disabled' : '';
  const acts = (html) => (c.pending ? '' : `<div class="actions">${html}</div>`); // the pending strip replaces them
  const comment = (ph) => `<textarea id="cm-${id}" data-draft="${id}" rows="1" placeholder="${esc(ph)}" ${off}>${esc(drafts.get(c.cardId) || '')}</textarea>`;
  if (v.type === 'decision') {
    const sel = picks.get(c.cardId);
    const anyImg = (v.options || []).some((o) => o.image?.path);
    const opt = (o) => {
      const src = o.image?.path && S.images[o.image.path];
      return `<button class="opt${sel === o.key ? ' on' : ''}${o.key === v.recommend ? ' rec' : ''}" data-act="select" data-card="${id}" data-v="${esc(o.key)}" aria-pressed="${sel === o.key}" ${off}>
        ${anyImg ? (src ? `<span class="opt-img"><img src="${src}" alt=""><span class="enlarge" role="button" aria-label="Enlarge the mockup" data-zoom="${esc(src)}">${icon('expand')}</span></span>` : '<span class="noimg">no mockup</span>') : ''}
        <span class="opt-text"><span class="opt-label"><b class="n">${esc(o.key)}</b>${esc(o.label)}</span>
        ${o.detail ? `<span class="opt-detail">${esc(o.detail)}</span>` : ''}
        ${o.key === v.recommend ? `<span class="rec-pill">${icon('check')}recommended</span>` : ''}</span></button>`;
    };
    const chosen = (v.options || []).find((o) => o.key === sel);
    return `<div class="opts${anyImg ? ' with-img' : ''}">${(v.options || []).map(opt).join('')}</div>
      ${comment('Comment for the PM (optional)')}
      ${acts(`<button class="btn primary" data-act="pick" data-card="${id}" ${chosen ? '' : 'disabled'}>${chosen ? `Pick ${esc(chosen.key)}` : 'Tap an option'}</button>
        <button class="btn" data-act="pick-none" data-card="${id}">Neither…</button>`)}`;
  }
  if (v.type === 'check') {
    const shots = v.images?.length ? v.images : (v.captions || []).map((caption) => ({ caption }));
    const mine = photos.get(c.cardId) || [];
    return `${shots.length ? `<div class="shots">${shots.map((x) => {
      const src = x.path && S.images[x.path];
      return `<figure>${src ? `<img src="${src}" alt="${esc(x.caption || v.title)}" data-zoom="${esc(src)}">` : `<div class="noimg">Image on the Mac</div>`}${x.caption ? `<figcaption>${esc(x.caption)}</figcaption>` : ''}</figure>`;
    }).join('')}</div>` : ''}
      ${comment('Comment (needed to send it back)')}
      <div class="photos">${mine.map((p, i) => `<span class="photo"><img src="${urlFor(p, p.blob)}" alt="">${c.pending ? '' : `<button class="x" data-act="unphoto" data-card="${id}" data-v="${i}" aria-label="Remove photo">${icon('x')}</button>`}</span>`).join('')}
        ${mine.length < MAX_PHOTOS && !c.pending ? `<label class="btn add-photo">${icon('camera')}${mine.length ? 'Add another' : 'Add photos'}<input type="file" accept="image/*" multiple data-photos="${id}" hidden></label>` : ''}</div>
      ${acts(`<button class="btn primary" data-act="accept" data-card="${id}">${icon('check')}Looks good, close it</button>
        <button class="btn" data-act="redo" data-card="${id}">Send back</button>`)}`;
  }
  if (v.type === 'inbox-ask') {
    return `${(v.options || []).length ? `<div class="choices">${v.options.map((o) => `<button class="btn" data-act="inbox-pick" data-card="${id}" data-v="${esc(o)}" ${off}>${esc(o)}</button>`).join('')}</div>` : ''}
      ${comment(v.options?.length ? 'Add a note (optional)' : 'Your answer')}
      ${acts(`${v.options?.length ? '' : `<button class="btn primary" data-act="inbox-reply" data-card="${id}">${icon('send')}Send</button>`}
        <button class="btn" data-act="inbox-dismiss" data-card="${id}">Dismiss</button>`)}`;
  }
  if (v.type === 'run-failed') return `${acts(`<button class="btn" data-act="clear" data-card="${id}">${icon('check')}Clear</button>`)}<p class="fine">The run’s log and a retry are on the Mac.</p>`;
  if (v.type === 'blocked') return `<div class="actions"><button class="btn" data-act="hide" data-card="${id}">Hide on the phone</button></div><p class="fine">It clears by itself when the ticket changes on the Mac.</p>`;
  return '';
}

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(240, t.scrollHeight + 2) + 'px'; }

// ---------- reports ----------

const agentName = (a) => (!a || a === 'claude' ? 'Claude' : a);
function reportState(r) {
  if (r.status === 'failed') return ['Failed', 'bad'];
  if (r.status === 'stopped') return ['Stopped', 'muted'];
  if (r.taskStatus === 'review') return ['In review', 'warn'];
  return ['Finished', 'good'];
}

// Runs started from this phone whose report has not come yet: sending, refused, or working on the Mac.
function phoneRuns() {
  const have = new Set(S.reports.map((r) => r.runId));
  return S.outbox.filter((c) => (c.kind === 'new-task' && c.fields?.delegate) || c.kind === 'delegate')
    .filter((c) => !(c.runId && have.has(String(c.runId))) && !(c.state === 'ok' && !c.runId))
    .filter((c) => c.state !== 'ok' || Date.now() - (c.resultAt || c.at) < 7 * 86400000);
}

function reportsView() {
  if (S.report) return reportDetail(S.reports.find((r) => r.runId === S.report));
  const waiting = phoneRuns().map((c) => {
    const d = c.kind === 'delegate' ? c.fields : c.fields.delegate;
    const [label, cls] = c.state === 'ok' ? ['Working on the Mac', 'muted'] : STATE[c.state] || [c.state, 'muted'];
    return `<li class="rep wait">
      <div class="cmd-top"><span class="pill ${cls}">${c.state === 'ok' || c.state === 'sent' || c.state === 'queued' ? '<span class="dot"></span>' : ''}${esc(label)}</span><time>${esc(ago(c.resultAt || c.sentAt || c.at))}</time></div>
      <div class="rep-title">${esc(c.fields.title || c.label || 'Delegated task')}</div>
      <div class="rep-meta">${icon('bot')}${esc(agentName(d?.agent))} · ${esc(MODES[d?.mode]?.[0] || d?.mode || 'Auto')}${c.fields.projectName ? ` · ${esc(c.fields.projectName)}` : ''}</div>
      ${c.state === 'ok' ? '<div class="fine">The report comes here when the run ends.</div>' : ''}
      ${c.state === 'error' || c.state === 'expired' || c.state === 'lost' ? `<div class="cmd-note bad">${esc(c.error)}</div><button class="btn sm" data-act="retry" data-v="${esc(c.id)}">${icon('sync')}Try again</button>` : ''}
    </li>`;
  }).join('');
  const rows = S.reports.map((r) => {
    const [label, cls] = reportState(r);
    return `<li><a class="rep${r.seen ? '' : ' unread'}" href="#/reports/${encodeURIComponent(r.runId)}">
      <div class="cmd-top"><span class="pill ${cls}">${esc(label)}</span>${r.via === 'phone' ? `<span class="chip quiet">${icon('phone')}from the phone</span>` : ''}<span class="grow"></span><time>${esc(ago(r.finishedAt || r.receivedAt))}</time></div>
      <div class="rep-title">${r.seen ? '' : '<span class="new-dot" aria-label="new"></span>'}${esc(r.taskTitle || 'Untitled task')}</div>
      <div class="rep-meta">${r.projectName ? `<span class="chip">${esc(r.projectName)}</span>` : ''}${icon('bot')}${esc(agentName(r.agent))}${r.kind ? ` · ${esc(r.kind)}` : ''}</div>
      <div class="rep-peek">${esc(peek(r.result))}</div>
    </a></li>`;
  }).join('');
  if (!rows && !waiting) {
    return `<div class="empty quiet">${icon('doc', 'i big')}<h2>No reports yet</h2><p>Final reports come here for runs that fail, runs that end in Review, and runs you start from this phone.</p><a class="btn primary" href="#/new">${icon('plus')}New task</a></div>`;
  }
  return `${waiting ? `<h2 class="sec">Started from this phone</h2><ul class="reps">${waiting}</ul>` : ''}
    ${rows ? `${waiting ? '<h2 class="sec">Reports</h2>' : ''}<ul class="reps">${rows}</ul>` : ''}`;
}

// The first real sentence of a report, for the list.
function peek(md) {
  const line = String(md || '').split('\n').filter((l) => !/^\s*(#|```|\|)/.test(l)).map((l) => l.replace(/^[#>*\-+\s\d.)]+/, '').replace(/[*_`]/g, '').trim()).find((l) => l.length > 3) || '';
  return line.length > 140 ? line.slice(0, 139) + '…' : line;
}

function reportDetail(r) {
  if (!r) return `<div class="empty quiet">${icon('doc', 'i big')}<h2>Report gone</h2><p>It was dismissed, or it is older than 30 days.</p><a class="btn" href="#/reports">${icon('back')}All reports</a></div>`;
  const [label, cls] = reportState(r);
  return `<article class="report">
    <a class="btn ghost back" href="#/reports">${icon('back')}Reports</a>
    <div class="cmd-top"><span class="pill ${cls}">${esc(label)}</span>${r.via === 'phone' ? `<span class="chip quiet">${icon('phone')}from the phone</span>` : ''}<span class="grow"></span><time>${esc(r.finishedAt ? clock(r.finishedAt) : '')}</time></div>
    <h2>${esc(r.taskTitle || 'Untitled task')}</h2>
    <div class="rep-meta">${r.projectName ? `<span class="chip">${esc(r.projectName)}</span>` : ''}${icon('bot')}${esc(agentName(r.agent))}${r.kind ? ` · ${esc(r.kind)}` : ''}</div>
    <div class="md">${r.result ? markdown(r.result) : '<p class="muted">The run left no report.</p>'}</div>
    <div class="actions"><button class="btn" data-act="dismiss-report" data-v="${esc(r.runId)}">${icon('check')}Done reading, remove it</button></div>
    <p class="fine">The run’s full log and a follow-up are on the Mac.</p>
  </article>`;
}

// ---------- new task ----------

// The directory's projects, agents and choices, cleaned up on the phone side too: only the three
// modes, never bypassPermissions.
function choices() {
  const d = S.directory || {};
  const projects = Array.isArray(d.projects) ? d.projects.filter((p) => p?.projectId && p.name) : [];
  const modes = (Array.isArray(d.modes) ? d.modes : ['auto']).filter((m) => Object.hasOwn(MODES, m));
  const models = Array.isArray(d.models) ? d.models.map(String) : [''];
  const efforts = Array.isArray(d.efforts) ? d.efforts.map(String) : [''];
  return { projects, modes: modes.length ? modes : ['auto'], models, efforts, perHour: Number.isInteger(d.perHour) ? d.perHour : null };
}
// Keeps the form inside what the directory allows (a project or agent can go away on the Mac).
function settleForm(c) {
  if (!c.projects.some((p) => p.projectId === form.projectId)) form.projectId = c.projects[0]?.projectId || '';
  const agents = c.projects.find((p) => p.projectId === form.projectId)?.agents || [];
  if (!agents.includes(form.agent)) form.agent = agents.includes('senior-dev') ? 'senior-dev' : agents[0] || '';
  if (!c.modes.includes(form.mode)) form.mode = c.modes[0];
  if (!c.models.includes(form.model)) form.model = c.models[0] ?? '';
  if (!c.efforts.includes(form.effort)) form.effort = c.efforts[0] ?? '';
  return agents;
}

function newView() {
  const c = choices();
  if (!c.projects.length) {
    return `<div class="empty quiet">${icon('plus', 'i big')}<h2>Waiting for the project list</h2><p>The Mac sends its projects and agents when the relay starts, and again every 30 minutes. ${S.macSeenAt ? '' : 'Nothing has come from the Mac yet.'}</p></div>`;
  }
  const agents = settleForm(c);
  const mine = photos.get(NEW_ID) || [];
  const seg = (name, list, label, cur) => `<div class="seg" role="radiogroup" aria-label="${esc(name)}">${list.map((v) => `<button type="button" class="${v === cur ? 'on' : ''}" role="radio" aria-checked="${v === cur}" data-act="set" data-k="${esc(name)}" data-v="${esc(v)}">${esc(label(v))}</button>`).join('')}</div>`;
  const recent = S.outbox.filter((x) => x.kind === 'new-task' && Date.now() - x.at < 86400000).length;
  return `<form class="newform" data-form="new" autocomplete="off">
    <label class="field">Project
      <select id="nf-project" data-field="projectId">${c.projects.map((p) => `<option value="${esc(p.projectId)}" ${p.projectId === form.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label class="field">Title
      <input type="text" id="nf-title" data-field="title" value="${esc(form.title)}" placeholder="What needs doing?" enterkeyhint="next" maxlength="300"></label>
    <label class="field">Details <span class="hint">Context and what done looks like. An agent reads this.</span>
      <textarea id="nf-notes" data-field="notes" rows="4" placeholder="e.g. The end card overlaps the CTA in portrait. Fix it and check a real build at 390×844.">${esc(form.notes)}</textarea></label>
    <div class="field">Priority${seg('priority', ['low', 'normal', 'high'], (v) => v[0].toUpperCase() + v.slice(1), form.priority)}</div>
    <div class="field">Photos <span class="hint">optional, up to ${MAX_PHOTOS}; they become the task’s Attachments</span>
      <div class="photos">${mine.map((p, i) => `<span class="photo"><img src="${urlFor(p, p.blob)}" alt=""><button type="button" class="x" data-act="unphoto" data-card="${NEW_ID}" data-v="${i}" aria-label="Remove photo">${icon('x')}</button></span>`).join('')}
        ${mine.length < MAX_PHOTOS ? `<label class="btn add-photo">${icon('camera')}${mine.length ? 'Add another' : 'Add photos'}<input type="file" accept="image/*" multiple data-photos="${NEW_ID}" hidden></label>` : ''}</div></div>
    <label class="switch"><input type="checkbox" id="nf-delegate" data-field="delegate" ${form.delegate ? 'checked' : ''}><span class="track"></span><span><b>Start an agent on it now</b><span class="hint">Otherwise it waits in To do on the Mac.</span></span></label>
    ${form.delegate ? `<fieldset class="delegate">
      <div class="field">Agent ${agents.length ? '' : '<span class="hint bad">No allowed agent for this project</span>'}
        <div class="agents" role="radiogroup" aria-label="Agent">${agents.map((a) => `<label class="agent${a === form.agent ? ' on' : ''}"><input type="radio" name="nf-agent" data-field="agent" value="${esc(a)}" ${a === form.agent ? 'checked' : ''}>${icon('bot')}<b>${esc(a === 'claude' ? 'Claude (default)' : a)}</b></label>`).join('')}</div></div>
      <div class="field">Permissions${seg('mode', c.modes, (m) => MODES[m][0], form.mode)}<span class="hint">${esc(MODES[form.mode]?.[1] || '')}</span></div>
      <div class="two">
        <label class="field">Model<select id="nf-model" data-field="model">${c.models.map((m) => `<option value="${esc(m)}" ${m === form.model ? 'selected' : ''}>${esc(m ? m[0].toUpperCase() + m.slice(1) : 'Default')}</option>`).join('')}</select></label>
        <label class="field">Effort<select id="nf-effort" data-field="effort">${c.efforts.map((e) => `<option value="${esc(e)}" ${e === form.effort ? 'selected' : ''}>${esc(e ? e[0].toUpperCase() + e.slice(1) : 'Default')}</option>`).join('')}</select></label>
      </div>
      <label class="field">Extra instructions <span class="hint">optional, for this run only</span>
        <textarea id="nf-extra" data-field="extra" rows="2" placeholder="e.g. Don’t touch the build folder.">${esc(form.extra)}</textarea></label>
      ${c.perHour ? `<p class="fine">At most ${c.perHour} runs an hour can start from the phone. The Mac checks this, and the agent and permissions, again before it starts anything.</p>` : ''}
    </fieldset>` : ''}
    <button class="btn primary big" type="submit" ${form.delegate && !agents.length ? 'disabled' : ''}>${form.delegate ? `${icon('send')}Create and start ${esc(agentName(form.agent))}` : `${icon('plus')}Create task`}</button>
    ${recent ? `<p class="fine center-text"><a href="#/${form.delegate ? 'reports' : 'outbox'}">${recent} made from the phone today</a></p>` : ''}
  </form>`;
}

async function submitNew() {
  const c = choices();
  const agents = settleForm(c);
  const title = form.title.trim();
  if (!title) { toast('Give the task a title'); document.getElementById('nf-title')?.focus(); return; }
  const project = c.projects.find((p) => p.projectId === form.projectId);
  const fields = { projectId: form.projectId, projectName: project?.name || '', title, notes: form.notes.trim(), priority: form.priority };
  if (form.delegate) {
    if (!agents.includes(form.agent)) return toast('Pick an agent');
    fields.delegate = { agent: form.agent, mode: form.mode, model: form.model, effort: form.effort, extra: form.extra.trim() };
  }
  const label = `${form.delegate ? `New task for ${agentName(form.agent)}` : 'New task'}: ${title}`;
  await queueCommand('new-task', fields, { label, files: photos.get(NEW_ID) || [] });
  localStorage.setItem('new.pref', JSON.stringify({ projectId: form.projectId, delegate: form.delegate, agent: form.agent, mode: form.mode, model: form.model, effort: form.effort }));
  Object.assign(form, { title: '', notes: '', extra: '', priority: 'normal' });
  photos.delete(NEW_ID);
  toast(form.delegate ? 'Sent. The Mac starts it within about 15 s' : 'Sent to the Mac');
  location.hash = form.delegate ? '#/reports' : '#/outbox';
  await refresh();
  syncNow();
}

// ---------- outbox ----------

const STATE = {
  queued: ['Waiting to send', 'warn'], sent: ['Sent, waiting for the Mac', 'muted'], ok: ['Done', 'good'],
  error: ['Refused', 'bad'], expired: ['Expired, not delivered', 'bad'], lost: ['Not sent', 'bad'],
};

function outboxView() {
  const st = S.status;
  const conn = connection();
  const u = S.session?.user || {};
  const rows = S.outbox.map((c) => {
    const [label, cls] = STATE[c.state] || [c.state, 'muted'];
    const note = c.state === 'ok' ? c.message : c.error;
    return `<li class="cmd">
      <div class="cmd-top"><span class="pill ${cls}">${c.state === 'queued' || c.state === 'sent' ? '<span class="dot"></span>' : ''}${esc(label)}</span><time>${esc(ago(c.resultAt || c.sentAt || c.at))}</time></div>
      <div class="cmd-label">${esc(c.label || c.kind)}</div>
      ${note ? `<div class="cmd-note ${c.state === 'ok' ? '' : 'bad'}">${esc(note)}</div>` : ''}
      ${c.files?.length ? `<div class="fine">${c.files.length} photo${c.files.length === 1 ? '' : 's'}</div>` : ''}
      ${['error', 'expired', 'lost'].includes(c.state) ? `<button class="btn sm" data-act="retry" data-v="${esc(c.id)}">${icon('sync')}Try again</button>` : ''}
    </li>`;
  }).join('');
  return `<section class="panel">
      <div class="row"><span class="dot-big ${conn.cls}"></span><div class="grow"><b>${esc(conn.text)}</b>${conn.tip ? `<div class="fine">${esc(conn.tip)}</div>` : ''}</div></div>
      <dl class="kv">
        <dt>Last sync</dt><dd>${st.lastOkAt ? esc(ago(st.lastOkAt)) : 'not yet'}</dd>
        ${st.error && st.failedAt > (st.lastOkAt || 0) ? `<dt>Problem</dt><dd class="bad">${esc(st.error)}</dd>` : ''}
        <dt>Signed in</dt><dd>${icon('github')}${esc(u.name || u.email || '?')}</dd>
        <dt>Key</dt><dd>version ${esc(S.keyVersion ?? '?')}, kept on this phone</dd>
      </dl>
      <div class="actions">
        <button class="btn" data-act="sync">${icon('sync')}Sync now</button>
        <button class="btn" data-act="resync">Resend everything</button>
      </div>
    </section>
    <h2 class="sec">Sent from this phone</h2>
    ${rows ? `<ul class="cmds">${rows}</ul>` : '<p class="fine pad">Nothing yet. Picks and answers you send show here, with what the Mac said back.</p>'}
    <div class="foot-actions"><button class="btn ghost" data-act="signout">${icon('out')}Sign out and forget this phone’s key</button></div>`;
}

// ---------- actions ----------

const cardOf = (id) => S.cards.find((c) => c.cardId === id);

async function send(kind, fields, card, label, files) {
  // The comment, pick and photos stay until the card leaves, so a refused command loses nothing.
  await queueCommand(kind, fields, { cardId: card?.cardId || null, label, files });
  await refresh();
  syncNow();
}

async function onAct(el) {
  const act = el.dataset.act;
  const id = el.dataset.card;
  const c = id ? cardOf(id) : null;
  const v = c?.value;
  const note = id ? (drafts.get(id) || '').trim() : '';
  const where = v ? ` · ${v.title}` : '';
  const needComment = (msg) => { toast(msg); document.getElementById(`cm-${id}`)?.focus(); };
  switch (act) {
    case 'signin': S.busy = true; render(); return auth.signInWithGitHub().catch((e) => { S.busy = false; S.error = e.message; render(); });
    case 'signout': {
      if (!confirm('Sign out? This phone forgets its key and everything it has cached. You’d type the passphrase again.')) return;
      return signedOut('');
    }
    case 'sync': S.syncing = true; render(); await syncNow(); S.syncing = false; return render();
    case 'resync': await send('resync', {}, null, 'Asked the Mac to resend everything'); return toast('Asked the Mac to send everything again');
    case 'retry': { await retryCommand(el.dataset.v); await refresh(); return syncNow(); }
    case 'select': picks.set(id, el.dataset.v); return render({ force: true });
    case 'pick': {
      const key = picks.get(id);
      const o = v.options.find((x) => x.key === key);
      if (!o) return;
      return send('answer', { taskId: v.taskId, askId: v.askId, pick: key, comment: note }, c, `Picked ${key}: ${o.label}${where}`);
    }
    case 'pick-none':
      if (!note) return needComment('Say what you want instead in the comment');
      return send('answer', { taskId: v.taskId, askId: v.askId, pick: 'none', comment: note }, c, `Neither option${where}`);
    case 'accept': return send('answer', { taskId: v.taskId, askId: v.askId, pick: 'accept', comment: note }, c, `Accepted${where}`);
    case 'redo':
      if (!note) return needComment('Say what should change in the comment');
      return send('answer', { taskId: v.taskId, askId: v.askId, pick: 'redo', comment: note }, c, `Sent back${where}`, photos.get(id) || []);
    case 'inbox-pick': return send('inbox-reply', { itemId: v.itemId, reply: note ? `${el.dataset.v}\n\n${note}` : el.dataset.v, status: 'done' }, c, `Answered “${el.dataset.v}”${where}`);
    case 'inbox-reply':
      if (!note) return needComment('Type your answer first');
      return send('inbox-reply', { itemId: v.itemId, reply: note, status: 'done' }, c, `Answered${where}`);
    case 'inbox-dismiss': return send('inbox-reply', { itemId: v.itemId, reply: note, status: 'dismissed' }, c, `Dismissed${where}`);
    case 'clear': return send('dismiss', { cardId: c.cardId }, c, `Cleared the failed run${where}`);
    case 'hide': await hideCard(c); await store.cards.del(c.cardId); return refresh();
    case 'unphoto': { const list = photos.get(id) || []; list.splice(Number(el.dataset.v), 1); return render({ force: true }); }
    case 'reload': S.update?.postMessage('skip-waiting'); return;
    case 'set': form[el.dataset.k] = el.dataset.v; return render({ force: true });
    case 'dismiss-report': {
      await dismissReport(el.dataset.v);
      location.hash = '#/reports';
      await refresh();
      return toast('Removed from this phone');
    }
  }
}

document.addEventListener('click', (e) => {
  const z = e.target.closest('[data-zoom]');
  if (z) { e.preventDefault(); e.stopPropagation(); return zoom(z.dataset.zoom); }
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) { e.preventDefault(); onAct(el).catch((err) => { console.error(err); toast(err.message); }); }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset?.draft) { drafts.set(t.dataset.draft, t.value); autoGrow(t); }
  if (t.dataset?.field && (t.type === 'text' || t.tagName === 'TEXTAREA')) { form[t.dataset.field] = t.value; if (t.tagName === 'TEXTAREA') autoGrow(t); }
});
// Choices on the New form: they change what else the form shows, so it redraws at once.
document.addEventListener('change', (e) => {
  const t = e.target;
  const k = t.dataset?.field;
  if (!k || t.type === 'text' || t.tagName === 'TEXTAREA') return;
  form[k] = t.type === 'checkbox' ? t.checked : t.value;
  t.blur(); // a focused select would hold back the redraw (see render)
  render({ force: true });
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!t.dataset?.photos) return;
  const id = t.dataset.photos;
  const list = photos.get(id) || [];
  for (const f of [...t.files].slice(0, MAX_PHOTOS - list.length)) {
    try { list.push(await downsize(f)); } catch (err) { toast(err.message); }
  }
  photos.set(id, list);
  render({ force: true });
});
document.addEventListener('submit', async (e) => {
  if (e.target.dataset.form === 'new') { e.preventDefault(); return submitNew().catch((err) => { console.error(err); toast(err.message); }); }
  if (e.target.dataset.form !== 'unlock') return;
  e.preventDefault();
  const pass = e.target.pass.value;
  if (!pass.trim()) return;
  S.busy = true; S.error = ''; render({ force: true });
  try {
    const r = await unlock(mailbox, pass);
    S.busy = false;
    if (!r.ok) { S.error = r.reason; render({ force: true }); document.getElementById('pass')?.focus(); return; }
    await enterMain();
  } catch (err) {
    S.busy = false;
    S.error = err.kind === 'network' ? 'Can’t reach Supabase right now. Check the connection and try again.' : err.message;
    render({ force: true });
  }
});

// Full-screen image: fitted; tap toggles 1:1 (then scroll to pan); pinch works through the page zoom.
function zoom(src) {
  const el = document.createElement('div');
  el.className = 'zoom';
  el.innerHTML = `<div class="zoom-stage"><img src="${esc(src)}" alt=""></div><button class="btn zoom-x" aria-label="Close">${icon('x')}</button>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.zoom-x') || e.target === el) return el.remove();
    if (e.target.tagName === 'IMG') el.classList.toggle('actual');
  });
  document.body.append(el);
}

// ---------- flow ----------

async function markSeen(runId) {
  // One transaction: a report removed meanwhile is not brought back.
  const r = await store.update('reports', runId, (old) => (old && !old.seen ? { ...old, seen: true } : undefined));
  if (r) await refresh();
}

async function enterMain() {
  S.screen = 'main'; S.error = '';
  S.keyVersion = (await keysNow())?.keyVersion;
  await store.kv.del('metaCheckedAt'); // check relay_meta on every start: a rekey shows at once
  if (S.report) markSeen(S.report);
  await refresh();
  startPolling();
}

// The sign-in ran out (or was revoked): only the session goes. The key, the cards and the outbox
// stay, so signing in again lands straight in the Inbox.
async function sessionLost() {
  stopPolling();
  await store.kv.del('session');
  Object.assign(S, { screen: 'signin', error: 'Your sign-in ran out. Sign in again; nothing on this phone was lost.', session: null, busy: false });
  render({ force: true });
}

async function signedOut(message) {
  stopPolling();
  await forgetKeys();
  await auth.signOut();
  await store.wipe();
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear(); drafts.clear(); picks.clear(); photos.clear();
  Object.assign(S, { screen: 'signin', error: message, session: null, cards: [], outbox: [], busy: false });
  render({ force: true });
}

function route() {
  const [, view, arg] = location.hash.match(/^#\/(inbox|reports|new|outbox)(?:\/(.+))?$/) || [, 'inbox'];
  S.view = view;
  S.report = view === 'reports' && arg ? decodeURIComponent(arg) : null;
  if (S.screen === 'main') {
    if (S.report) markSeen(S.report);
    window.scrollTo(0, 0);
    if (S.view === 'outbox') store.outbox.all().then(async (all) => { for (const c of all) if (c.state === 'error' && !c.seen) await store.outbox.put({ ...c, seen: true }); });
    render({ force: true });
  }
}
addEventListener('hashchange', route);
addEventListener('online', () => S.screen === 'main' && syncNow());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.screen === 'main') syncNow(); });

async function boot() {
  route();
  if (!CONFIG.supabaseUrl || !CONFIG.anonKey) { S.screen = 'config'; return render(); }
  auth = createAuth({ url: CONFIG.supabaseUrl, anonKey: CONFIG.anonKey });
  mailbox = createMailbox({ url: CONFIG.supabaseUrl, anonKey: CONFIG.anonKey, auth });
  sync = createSync({ mailbox, onChange: () => { refresh(); } });
  try {
    await auth.finishRedirect();
  } catch (e) {
    S.error = e instanceof AuthError ? `Sign-in didn’t work: ${e.message}` : e.message;
  }
  S.session = await auth.session();
  if (!S.session) { S.screen = 'signin'; return render(); }
  if (!(await keysNow())) { S.screen = 'passphrase'; S.rekeyed = await store.kv.get('rekeyed'); return render(); }
  return enterMain();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ready = (w) => { S.update = w; toast('A new version is ready', { action: { act: 'reload', label: 'Reload' } }); };
    if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ready(w); });
    });
  }).catch((e) => console.warn('service worker:', e.message));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.update && !reloaded) { reloaded = true; location.reload(); } });
}

boot().catch((e) => { console.error(e); $app.innerHTML = `<main class="gate"><h1>Something broke</h1><p class="err">${esc(e.message)}</p></main>`; });
