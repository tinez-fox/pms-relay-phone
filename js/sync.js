// The phone's relay loop: the mirror of the suite's lib/relay.js.
//
//   pull   down rows → decrypt → into IndexedDB → delete the row (delivery = delete). Card images
//          are fetched, decrypted, stored and deleted from the bucket before the card row goes.
//   flush  outbox commands → (upload images) → encrypt → insert an up row whose id is the command id
//   meta   relay_meta's key_version and verifier: a rekey on the Mac means "type the new passphrase"
//
// Every step is safe to repeat: a row is deleted only after what it carried is committed locally,
// a card is replaced by cardId, a command is inserted under its own id (a second insert is a
// conflict, which counts as sent), and a result is matched to its command by id.
//
// Command status (the phone cannot read up rows, so "delivered" is when the Mac's result arrives):
//   queued → sent → ok | error            plus  expired (sent, no result within 7 days)
//                                               lost (still queued at a rekey or sign-out)
import { decryptRow, encryptRow, decryptBlob, encryptBlob, checkVerifier, deriveKeys, RelayCryptoError } from './relay_crypto.js';
import * as store from './store.js';
import { MailboxError } from './mailbox.js';

const DAY = 86400000;
export const KEEP_MS = 30 * DAY;            // Q6: delivered items stay 30 days, or until dismissed
export const COMMAND_LIFE_MS = 7 * DAY;     // the mailbox's own limit: an unapplied command expires
const META_MS = 5 * 60000;
const CARD_ACTIONS = new Set(['answer', 'inbox-reply', 'dismiss']);
const MAX_IMAGES = 6;

export const uuid = () => crypto.randomUUID?.() || ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

let memoryKeys = null; // only when the browser cannot keep a CryptoKey in IndexedDB

// The stored key bundle: { encKey, refKey, keyVersion } or null.
export async function loadKeys() {
  const k = await store.kv.get('keys');
  return k?.encKey && k?.refKey && Number.isInteger(k.keyVersion) ? k : null;
}

// Passphrase → keys, checked against relay_meta's verifier. Nothing is stored unless it matches.
// Returns { ok: true } or { ok: false, reason }.
export async function unlock(mailbox, passphrase) {
  const meta = await mailbox.getMeta();
  if (!meta) return { ok: false, reason: 'not-member' };
  const keys = await deriveKeys(passphrase, meta.kdf);
  if (!(await checkVerifier(keys, meta.verifier, meta.key_version))) return { ok: false, reason: 'wrong' };
  try {
    await store.kv.set('keys', { ...keys, keyVersion: meta.key_version });
  } catch {
    // A browser that cannot store a CryptoKey: keep it for this session only.
    memoryKeys = { ...keys, keyVersion: meta.key_version };
  }
  await store.kv.set('metaCheckedAt', Date.now());
  await store.kv.del('rekeyed');
  await store.persist();
  return { ok: true };
}
export const keysNow = async () => (await loadKeys()) || memoryKeys;
export const forgetKeys = async () => { memoryKeys = null; await store.kv.del('keys'); };

// What the Mac sent last: the directory's own sentAt (the 30-minute heartbeat) or the newest row.
async function noteSeen(iso) {
  if (!iso) return;
  const t = Date.parse(iso);
  if (!(t > 0)) return;
  const old = await store.kv.get('macSeenAt');
  if (!old || old < t) await store.kv.set('macSeenAt', t);
}

export function createSync({ mailbox, onChange = () => {}, log = console, now = Date.now }) {
  let running = null;
  let again = false;

  const status = async (patch) => {
    const s = { ...(await store.kv.get('status')), ...patch };
    await store.kv.set('status', s);
    return s;
  };

  // ---- meta ----

  // 'ok' | 'rekey' (the Mac has a new key: ask for the new passphrase) | 'not-member'
  async function checkMeta(keys) {
    const meta = await mailbox.getMeta();
    await store.kv.set('metaCheckedAt', now());
    if (!meta) return 'not-member';
    if (meta.key_version === keys.keyVersion && (await checkVerifier(keys, meta.verifier, meta.key_version).catch(() => false))) return 'ok';
    // Rekeyed (`scripts/relay.mjs rekey`): the mailbox was emptied, so unsent commands are lost.
    await forgetKeys();
    for (const c of await store.outbox.all()) {
      if (c.state === 'queued') await store.outbox.put({ ...c, state: 'lost', error: 'Not sent: the relay passphrase changed on the Mac before it went', resultAt: now() });
    }
    await store.kv.set('rekeyed', { at: now(), keyVersion: meta.key_version });
    return 'rekey';
  }

  // ---- down ----

  async function storeImages(keys, paths) {
    const got = [];
    for (const path of paths) {
      if (await store.blobs.get(path)) { got.push(path); continue; }
      let bytes;
      try { bytes = await mailbox.getBlob(path); } catch (e) {
        if (e.kind === 'missing') { log.warn('relay: card image gone from the bucket', path); continue; }
        throw e;
      }
      let plain;
      try { plain = await decryptBlob(keys, path, bytes); } catch (e) {
        if (!(e instanceof RelayCryptoError)) throw e;
        log.warn('relay: a card image did not decrypt', path);
        continue;
      }
      await store.blobs.put({ path, blob: new Blob([plain], { type: sniffType(plain) }), at: now() });
      got.push(path);
    }
    // Delivery = delete. Best effort: the Mac deletes a closed card's blobs and sweeps after 7 days.
    if (got.length) await mailbox.deleteBlobs(got).catch((e) => log.warn('relay: could not delete delivered blobs', e.message));
  }

  async function onCard(keys, row, v) {
    if (typeof v?.cardId !== 'string') throw new RelayCryptoError('card without a cardId');
    const hidden = (await store.kv.get('hidden')) || {};
    if (hidden[v.cardId] && hidden[v.cardId] === (v.title || '')) return; // a blocked ticket Tine hid, unchanged
    const paths = cardImagePaths(v);
    if (paths.length) await storeImages(keys, paths);
    await store.update('cards', v.cardId, (old) => ({
      cardId: v.cardId, ref: row.ref, value: v,
      receivedAt: old?.receivedAt || now(), updatedAt: now(),
      pending: old?.pending || null, error: old?.error || null,
    }));
  }

  async function dropCard(cardId) {
    const c = await store.cards.get(cardId);
    if (!c) return;
    await store.cards.del(cardId);
    for (const p of cardImagePaths(c.value)) await store.blobs.del(p);
  }

  async function onResult(v) {
    const cmd = await store.outbox.get(v.id);
    if (!cmd) return; // a command from an earlier install
    // Local image copies are kept until the Mac took the command, so a refused one can be retried.
    const files = v.ok ? (cmd.files || []).map(({ blob, ...f }) => f) : cmd.files;
    await store.outbox.put({ ...cmd, files, state: v.ok ? 'ok' : 'error', message: v.message || '', error: v.ok ? '' : v.error || 'The Mac refused it', taskId: v.taskId || null, runId: v.runId || null, resultAt: now() });
    if (!cmd.cardId) return;
    if (v.ok && CARD_ACTIONS.has(cmd.kind)) return dropCard(cmd.cardId);
    // Refused: the card is live again, with the reason on it.
    await store.update('cards', cmd.cardId, (c) => (c && c.pending?.cmdId === cmd.id ? { ...c, pending: null, error: v.error || 'The Mac refused it' } : undefined));
  }

  async function apply(keys, row, v) {
    switch (row.kind) {
      case 'card': return onCard(keys, row, v);
      case 'card-gone': return dropCard(v?.cardId);
      case 'result': return onResult(v);
      case 'report': {
        const runId = String(v.runId);
        if (((await store.kv.get('dismissedReports')) || {})[runId]) return; // a resend of one Tine removed
        // A resend replaces the report but keeps whether it was read.
        return store.update('reports', runId, (old) => ({ ...v, runId, receivedAt: old?.receivedAt || now(), seen: !!old?.seen }));
      }
      case 'directory': await store.kv.set('directory', v); return noteSeen(v.sentAt);
      default: log.warn('relay: unknown down kind', row.kind);
    }
  }

  // Returns 'ok' | 'rekey' | 'not-member'.
  async function pull(keys) {
    let metaChecked = false;
    for (let round = 0; round < 10; round++) {
      const rows = await mailbox.listDown(50);
      if (!rows.length) return 'ok';
      for (const row of rows) {
        let v;
        try {
          v = await decryptRow(keys, row);
        } catch (e) {
          if (!(e instanceof RelayCryptoError)) throw e;
          // Maybe the Mac rekeyed: ask relay_meta before throwing anything away.
          if (!metaChecked) { metaChecked = true; const m = await checkMeta(keys); if (m !== 'ok') return m; }
          log.warn(`relay: dropped a ${row.kind} row that did not decrypt`);
          await mailbox.deleteRow(row.id);
          continue;
        }
        await apply(keys, row, v);
        await noteSeen(row.created_at);
        await mailbox.deleteRow(row.id);
      }
      onChange();
      if (rows.length < 50) return 'ok';
    }
    return 'ok';
  }

  // ---- up ----

  async function uploadImages(keys, cmd, uid) {
    if (!cmd.files?.length) return cmd;
    const files = [];
    for (const f of cmd.files) {
      if (f.path) { files.push(f); continue; }
      const path = `${uid}/${uuid()}.bin`;
      const plain = new Uint8Array(await f.blob.arrayBuffer());
      await mailbox.putBlob(path, await encryptBlob(keys, path, plain));
      files.push({ ...f, path });
      // Saved before the command goes, so a retry does not upload it again.
      await store.outbox.put({ ...cmd, files: [...files, ...cmd.files.slice(files.length)] });
    }
    return { ...cmd, files };
  }

  async function flush(keys, uid) {
    const queued = (await store.outbox.all()).filter((c) => c.state === 'queued').sort((a, b) => a.at - b.at);
    for (let cmd of queued) {
      if (now() - cmd.at > COMMAND_LIFE_MS) { await store.outbox.put({ ...cmd, state: 'expired', error: 'Not sent within 7 days', resultAt: now() }); continue; }
      cmd = await uploadImages(keys, cmd, uid);
      const images = (cmd.files || []).map((f) => ({ path: f.path, name: f.name, type: f.type, w: f.w, h: f.h }));
      const plain = { id: cmd.id, at: new Date(cmd.at).toISOString(), ...cmd.fields, ...(images.length && { images }) };
      const { iv, body } = await encryptRow(keys, { dir: 'up', kind: cmd.kind, ref: null, keyVersion: keys.keyVersion }, plain);
      await mailbox.insertUp({ id: cmd.id, kind: cmd.kind, key_version: keys.keyVersion, iv, body });
      await store.outbox.put({ ...cmd, state: 'sent', sentAt: now() });
      onChange();
    }
  }

  // ---- housekeeping ----

  async function prune() {
    const t = now();
    for (const c of await store.outbox.all()) {
      if (c.state === 'sent' && t - c.sentAt > COMMAND_LIFE_MS) await store.outbox.put({ ...c, state: 'expired', error: 'The Mac did not pick it up within 7 days', resultAt: t });
      else if (['ok', 'error', 'expired', 'lost'].includes(c.state) && t - (c.resultAt || c.at) > KEEP_MS) await store.outbox.del(c.id);
    }
    for (const c of await store.cards.all()) if (t - c.receivedAt > KEEP_MS) await dropCard(c.cardId);
    for (const r of await store.reports.all()) if (t - r.receivedAt > KEEP_MS) await store.reports.del(r.runId);
    const live = new Set((await store.cards.all()).flatMap((c) => cardImagePaths(c.value)));
    for (const b of await store.blobs.all()) if (!live.has(b.path)) await store.blobs.del(b.path);
  }

  // ---- one pass ----

  // { state: 'ok' | 'offline' | 'paused' | 'signin' | 'rekey' | 'not-member' | 'locked', error? }
  async function pass() {
    const keys = await keysNow();
    if (!keys) return { state: 'locked' };
    const session = await store.kv.get('session');
    if (!session) return { state: 'signin', error: 'Not signed in' };
    try {
      if (now() - ((await store.kv.get('metaCheckedAt')) || 0) > META_MS) {
        const m = await checkMeta(keys);
        if (m !== 'ok') return { state: m };
      }
      await flush(keys, session.user.id);
      const p = await pull(keys);
      if (p !== 'ok') return { state: p };
      await prune();
      await status({ lastOkAt: now(), error: null, state: 'ok' });
      return { state: 'ok' };
    } catch (e) {
      if (!(e instanceof MailboxError)) log.error('relay:', e);
      const state = e.kind === 'paused' ? 'paused' : e.kind === 'signin' ? 'signin' : 'offline';
      await status({ state, error: e.message, failedAt: now() });
      return { state, error: e.message };
    }
  }

  return {
    // One pass at a time; a call during a pass schedules exactly one more.
    run() {
      if (running) { again = true; return running; }
      running = (async () => {
        let r;
        do { again = false; r = await pass(); onChange(); } while (again && r.state === 'ok');
        return r;
      })().finally(() => { running = null; });
      return running;
    },
    checkMeta: async () => { const k = await keysNow(); return k ? checkMeta(k) : 'locked'; },
  };
}

// ---- commands (the UI's entry point) ----

// Puts a command in the outbox. `fields`: the command's body (see the suite's lib/relay.js
// applyCommand). `cardId`: the card it acts on, which shows "sending" until the result comes.
// `files`: [{ blob, name, type, w, h }] already downsized (images.js).
// `at` is strictly increasing, so commands queued in the same millisecond still go (and are
// applied on the Mac) in the order they were made: a rate-limit burst, or a new-task followed by a
// delegate that names it (taskFromCmd).
let lastAt = 0;
export async function queueCommand(kind, fields, { cardId = null, label = '', files = [] } = {}) {
  lastAt = Math.max(Date.now(), lastAt + 1);
  const cmd = { id: uuid(), kind, fields, cardId, label, files: files.slice(0, MAX_IMAGES), at: lastAt, state: 'queued' };
  await store.outbox.put(cmd);
  if (cardId) await store.update('cards', cardId, (c) => (c ? { ...c, pending: { cmdId: cmd.id, label }, error: null } : undefined));
  return cmd;
}

// Try a refused or expired command again under a new id (the Mac remembers the old id's result).
export async function retryCommand(id) {
  const old = await store.outbox.get(id);
  if (!old || !['error', 'expired', 'lost'].includes(old.state)) return null;
  await store.outbox.del(id);
  return queueCommand(old.kind, old.fields, { cardId: old.cardId, label: old.label, files: (old.files || []).filter((f) => f.blob).map(({ path, ...f }) => f) });
}

// Tine is done with a report: it goes from the phone, and a resend of it is ignored (for 30 days).
export async function dismissReport(runId) {
  // Remembered first, so a resend arriving in between is already ignored.
  const gone = (await store.kv.get('dismissedReports')) || {};
  const t = Date.now();
  for (const [id, at] of Object.entries(gone)) if (t - at > KEEP_MS) delete gone[id];
  gone[runId] = t;
  await store.kv.set('dismissedReports', gone);
  await store.reports.del(runId);
}

// A blocked ticket's card, hidden here only (the Mac clears it when the ticket changes). If the
// card comes back with other text, it shows again.
export async function hideCard(card) {
  const hidden = (await store.kv.get('hidden')) || {};
  hidden[card.cardId] = card.value.title || '';
  await store.kv.set('hidden', hidden);
}

// The storage paths a card's images live at, in display order. Contract with the Mac side (R4):
//   check cards     value.images: [{ path, caption?, w?, h? }]
//   decision cards  value.options[i].image: { path, w?, h? } | null
export function cardImagePaths(v) {
  const out = [];
  for (const x of Array.isArray(v?.images) ? v.images : []) if (typeof x?.path === 'string') out.push(x.path);
  for (const o of Array.isArray(v?.options) ? v.options : []) if (typeof o?.image?.path === 'string') out.push(o.image.path);
  return out;
}

function sniffType(u) {
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg';
  if (u[0] === 0x89 && u[1] === 0x50) return 'image/png';
  if (u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57) return 'image/webp';
  if (u[0] === 0x47 && u[1] === 0x49) return 'image/gif';
  return 'application/octet-stream';
}
