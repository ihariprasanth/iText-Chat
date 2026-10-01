// iText Chat — anonymous peer-to-peer group chat, voice notes and file transfer.
// is the hub (host). Every other member keeps a single WebRTC data channel to it and
// the hub relays messages and file chunks. A full mesh would need n·(n−1)/2
// connections (1,225 for 50 people); the star needs n−1.
// If the hub disappears, the next member in join order claims the room ID and
// everyone else reconnects to them, so the group outlives whoever created it.
// Nothing is stored anywhere: each device only keeps what it has shown on screen.
(() => {
  'use strict';

  const PREFIX = 'itext-room-';
  const MAX_MEMBERS = 100;
  const CHUNK = 64 * 1024;             // file slice per message
  const WINDOW = 8;                    // chunks per flow-control window (512 KB)
  const HIGH_WATER = 4 * 1024 * 1024;  // a sender pauses above this much buffered data
  const RELAY_LOW = 1024 * 1024;       // the hub waits for each member to drain below this
  const SLOW_MEMBER_MS = 20000;        // a member that can't keep up is skipped for that file
  const JOIN_TIMEOUT = 20000;
  const RECONNECT_TRY_MS = 8000;
  const RECOVERY_MS = 75000;           // stop trying to reconnect after this
  const CLAIM_STAGGER = 2500;          // member #k waits k × this (capped) before trying to take over
  const CLAIM_MAX_WAIT = 15000;        // the broker lets only one claim win, so nobody waits longer
  const PEER_TIMEOUT = 35000;          // silence for this long = the connection is dead
  const MAX_VOICE_SEC = 300;
  const WAVE_BARS = 36;

  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $('joinForm'), nameInput: $('nameInput'), meAvatar: $('meAvatar'),
    roomInput: $('roomInput'), dice: $('diceBtn'), create: $('createBtn'), join: $('joinBtn'), homeStatus: $('homeStatus'),
    roomAvatar: $('roomAvatar'), roomTitle: $('roomTitle'), presence: $('presence'), who: $('whoBtn'),
    membersBtn: $('membersBtn'), memberCount: $('memberCount'), inviteBtn: $('inviteBtn'), leave: $('leaveBtn'),
    messages: $('messages'), empty: $('empty'), emptyCode: $('emptyCode'), emptyInvite: $('emptyInvite'), emptyCopy: $('emptyCopy'),
    list: $('list'), typing: $('typing'), typingLabel: $('typingLabel'), jump: $('jumpBtn'), jumpCount: $('jumpCount'),
    composer: $('composer'), banner: $('banner'), bannerText: $('bannerText'), rejoin: $('rejoinBtn'), bannerLeave: $('bannerLeaveBtn'),
    composeBar: $('composeBar'), attach: $('attachBtn'), file: $('fileInput'), input: $('msgInput'), send: $('sendBtn'),
    recBar: $('recBar'), recCancel: $('recCancel'), recSend: $('recSend'), recTime: $('recTime'), recScope: $('recScope'),
    drawer: $('drawer'), drawerClose: $('drawerClose'), drawerCount: $('drawerCount'), memberSearch: $('memberSearch'), memberList: $('memberList'), drawerInvite: $('drawerInvite'),
    inviteModal: $('inviteModal'), inviteClose: $('inviteClose'), inviteCode: $('inviteCode'), inviteLink: $('inviteLink'), copyLink: $('copyLinkBtn'), qr: $('qr'), share: $('shareBtn'),
    drop: $('drop'), lightbox: $('lightbox'), lbImg: $('lbImg'), lbName: $('lbName'), lbDownload: $('lbDownload'), lbClose: $('lbClose'),
    toast: $('toast'), favicon: $('favicon'),
    pane: $('pane'), chatHead: $('chatHead'), menuClock: $('menuClock'),
    sideAvatar: $('sideAvatar'), sideTitle: $('sideTitle'), sideTime: $('sideTime'), sidePreview: $('sidePreview'),
    sideMembers: $('sideMembers'), sideCount: $('sideCount'), sideSearch: $('sideSearch'), sideInvite: $('sideInvite'),
  };

  // ---------------------------------------------------------------- helpers
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const randInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const pick = (arr) => arr[randInt(arr.length)];
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, '0')).join('');
  const hash = (s) => { let x = 2166136261; for (const c of String(s)) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDur = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const cleanRoom = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const initials = (name) => (String(name).split(' ').filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('') || '?').toUpperCase();
  const coarse = matchMedia('(pointer: coarse)').matches;
  const baseUrl = () => location.href.split(/[?#]/)[0];
  const inviteLink = () => `${baseUrl()}?room=${encodeURIComponent(room)}`;
  const err = (code, msg) => Object.assign(new Error(msg || code), { code });

  let toastTimer = 0;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2800);
  }

  async function copy(text, done = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch {
      const t = h('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.append(t); t.select();
      try { document.execCommand('copy'); toast(done); } catch { prompt('Copy this:', text); }
      t.remove();
    }
  }

  function paintAvatar(el, name, seed) {
    el.textContent = initials(name);
    el.style.setProperty('--hue', hash(seed ?? name) % 360);
  }

  // ---------------------------------------------------------------- theme
  const THEME_COLORS = { dark: '#0B0D14', light: '#E9EDF5' };
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]').content = THEME_COLORS[t];
  }
  setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  document.querySelectorAll('[data-action="theme"]').forEach((b) => b.addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    try { localStorage.setItem('itext-theme', t); } catch { /* private mode */ }
  }));
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('itext-theme'); } catch { /* ignore */ }
    if (!saved) setTheme(e.matches ? 'light' : 'dark');
  });

  // ---------------------------------------------------------------- menu bar clock
  function tickClock() {
    ui.menuClock.textContent = new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).replace(/,/g, '');
  }
  tickClock();
  setInterval(tickClock, 15000);

  // ---------------------------------------------------------------- state
  const ADJ = ['Silent', 'Velvet', 'Midnight', 'Amber', 'Cobalt', 'Hidden', 'Lunar', 'Swift', 'Quiet', 'Neon', 'Misty', 'Golden', 'Crimson', 'Frosty', 'Wild', 'Cosmic'];
  const ANI = ['Otter', 'Falcon', 'Fox', 'Lynx', 'Heron', 'Panda', 'Raven', 'Tiger', 'Koala', 'Orca', 'Wolf', 'Moth', 'Gecko', 'Owl', 'Bison', 'Crane'];
  const me = { id: uid(), name: '' };   // id is per tab session, stable across reconnects

  let role = null;          // 'host' | 'guest' | null
  let room = '';
  let peer = null;          // our registered PeerJS peer
  let conn = null;          // guest: the welcomed connection to the hub
  let hostId = null;        // member id of the current hub
  let roster = [];          // [{ id, name }]: hub first, then join order
  let epoch = 0;            // bumps whenever the connection context changes
  let everJoined = false;
  let hostLastSeen = 0;
  let pendingJoin = null;   // guest: connection waiting for "welcome"
  let recovery = null;      // guest: reconnect / take-over loop
  let connState = 'online'; // 'online' | 'unstable' | 'reconnecting' | 'offline'

  const members = new Map();   // hub only: memberId -> { conn, name, lastSeen }
  const relays = new Map();    // hub only: fileId -> { id, from, recips, count, chain }
  const receipts = new Map();  // hub only: msgId -> { id, from, recips, d, r }

  const sent = new Map();      // my message/file id -> { tick, state }
  const incoming = new Map();  // file id -> { a, parts, got }
  const outgoing = new Set();  // my queued/in-flight file items
  const credits = new Map();   // my in-flight file id -> { n, wake }
  const typers = new Map();    // member id -> { name, timer }
  const pendingRead = new Set();
  const objectUrls = [];
  let sendQueue = Promise.resolve();

  const view = () => document.body.dataset.view;
  const show = (v) => { document.body.dataset.view = v; };
  const canSend = () => role === 'host' || (role === 'guest' && !!conn && conn.open);
  const nameOf = (id) => id === me.id ? me.name : (members.get(id)?.name ?? roster.find((x) => x.id === id)?.name ?? 'Someone');
  function track(url) { objectUrls.push(url); return url; }

  // ---------------------------------------------------------------- home form
  function homeStatus(msg, kind = '') { ui.homeStatus.textContent = msg; ui.homeStatus.className = `status ${kind}`; }
  function setBusy(btn) {
    [ui.create, ui.join].forEach((b) => { b.disabled = !!btn; b.classList.toggle('loading', b === btn); });
    ui.roomInput.disabled = ui.nameInput.disabled = ui.dice.disabled = !!btn;
  }
  function setUrl(name) {
    try { history.replaceState(null, '', name ? `?room=${encodeURIComponent(name)}` : baseUrl()); } catch { /* file:// */ }
  }
  const markBad = (input, bad) => input.closest('.field').classList.toggle('bad', bad);

  function readForm() {
    const name = cleanName(ui.nameInput.value);
    const r = cleanRoom(ui.roomInput.value);
    markBad(ui.nameInput, !name);
    markBad(ui.roomInput, !!name && !r);
    if (!name) { homeStatus('Enter your name first, so people know who is talking.', 'err'); ui.nameInput.focus(); return null; }
    if (!r) { homeStatus('Enter a room ID: letters, numbers, - or _.', 'err'); ui.roomInput.focus(); return null; }
    ui.nameInput.value = name;
    ui.roomInput.value = r;
    me.name = name;
    try { localStorage.setItem('itext-name', name); } catch { /* private mode */ }
    return r;
  }

  try { ui.nameInput.value = localStorage.getItem('itext-name') || ''; } catch { /* private mode */ }
  const paintMe = () => paintAvatar(ui.meAvatar, cleanName(ui.nameInput.value) || '?', cleanName(ui.nameInput.value));
  paintMe();
  ui.nameInput.addEventListener('input', () => { markBad(ui.nameInput, false); paintMe(); if (ui.homeStatus.classList.contains('err')) homeStatus(''); });
  ui.roomInput.addEventListener('input', () => { markBad(ui.roomInput, false); ui.join.classList.remove('pulse'); if (ui.homeStatus.classList.contains('err')) homeStatus(''); });
  ui.dice.addEventListener('click', () => {
    const tail = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    ui.roomInput.value = `${pick(ADJ)}-${pick(ANI)}-${tail}`.toLowerCase();
    markBad(ui.roomInput, false);
    ui.roomInput.focus();
  });
  ui.create.addEventListener('click', createRoom);
  ui.form.addEventListener('submit', (e) => { e.preventDefault(); joinRoom(); });

  // ---------------------------------------------------------------- PeerJS plumbing
  function openPeer(id) {
    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') { reject(err('lib')); return; }
      const p = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
      let opened = false;
      const timer = setTimeout(() => { if (!opened) { try { p.destroy(); } catch { /* */ } reject(err('network')); } }, 15000);
      p.on('open', () => { opened = true; clearTimeout(timer); resolve(p); });
      p.on('error', (e) => {
        if (!opened) { clearTimeout(timer); try { p.destroy(); } catch { /* */ } reject(Object.assign(e, { code: e.type })); return; }
        onPeerError(p, e);
      });
      p.on('disconnected', () => {
        // Lost the broker only. Existing chats keep working; re-register quietly.
        setTimeout(() => { if (p === peer && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch { /* heartbeat retries */ } } }, 1500);
      });
    });
  }

  function onPeerError(p, e) {
    if (e.type === 'peer-unavailable') { settleJoin(err('unavailable')); return; }
    if (p !== peer) return;
    // Someone else took the room ID while we were offline: we're not the hub any more.
    if (e.type === 'unavailable-id' && role === 'host') { demoteToGuest(); return; }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { settleJoin(err('network')); return; }
    console.warn('peer error', e);
  }

  function peerErrorText(e) {
    if (e.code === 'browser-incompatible') return 'This browser does not support WebRTC. Try Chrome, Edge, Firefox or Safari.';
    if (e.code === 'lib') return 'Could not load the connection library. Check your internet and reload.';
    return "Can't reach the signalling server. Check your internet connection and try again.";
  }

  function watchIce(c, onDead) {
    const pc = c.peerConnection;
    if (!pc) return;
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      if (role === 'guest' && c === conn) {
        if (s === 'disconnected') { connState = 'unstable'; renderPresence(); }
        else if ((s === 'connected' || s === 'completed') && connState === 'unstable') { connState = 'online'; renderPresence(); }
      }
      if (s === 'failed' || s === 'closed') onDead();
    });
  }

  function drained(dc, ms = 0) {
    return new Promise((resolve) => {
      let t = 0;
      const done = () => { clearTimeout(t); dc.removeEventListener('bufferedamountlow', done); dc.removeEventListener('close', done); resolve(); };
      dc.addEventListener('bufferedamountlow', done);
      dc.addEventListener('close', done);
      if (ms) t = setTimeout(done, ms);
    });
  }

  // ---------------------------------------------------------------- hub (host) side
  async function createRoom() {
    const r = readForm();
    if (!r) return;
    primeAlerts();
    teardown();
    resetChat();
    room = r;
    setBusy(ui.create);
    homeStatus(`Opening #${r}…`);
    let p;
    try { p = await openPeer(PREFIX + r); }
    catch (e) {
      setBusy(null);
      homeStatus(e.code === 'unavailable-id' ? `#${r} is already open. Tap Join room to go in, or pick a different room ID.` : peerErrorText(e), 'err');
      return;
    }
    if (room !== r || role) { p.destroy(); return; }
    becomeHost(p, true);
  }

  function becomeHost(p, fresh) {
    if (peer && peer !== p) { try { peer.destroy(); } catch { /* */ } }
    stopRecovery();
    epoch++; wakeCredits();
    peer = p; role = 'host'; conn = null;
    members.clear(); relays.clear(); receipts.clear();
    connState = 'online';
    p.on('connection', onIncoming);
    keepAlive(true); setUrl(room); setBusy(null); homeStatus('');
    setBanner(null);
    enterChat();
    applyRoster({ host: me.id, members: [{ id: me.id, name: me.name }] }, true);
    if (!fresh) sys('You are now hosting this group. Everyone else is reconnecting to you.', 'crown');
    everJoined = true;
    refreshChrome();
  }

  function onIncoming(c) {
    let memberId = null;
    const joinTimer = setTimeout(() => { if (!memberId) { try { c.close(); } catch { /* */ } } }, 15000);
    c.on('open', () => {
      if (c.dataChannel) c.dataChannel.bufferedAmountLowThreshold = RELAY_LOW;
      watchIce(c, () => { if (memberId) dropMember(memberId, c); });
    });
    c.on('data', (m) => {
      if (role !== 'host' || !m || typeof m !== 'object') return;
      if (!memberId) {
        if (m.t === 'join') { clearTimeout(joinTimer); memberId = admit(c, m); }
        return;
      }
      const mem = members.get(memberId);
      if (!mem || mem.conn !== c) return;
      mem.lastSeen = Date.now();
      hostHandle(memberId, m);
    });
    c.on('close', () => { clearTimeout(joinTimer); if (memberId) dropMember(memberId, c); });
    c.on('error', () => { /* close follows */ });
  }

  function uniqueName(name, id) {
    const taken = new Set([me.name, ...[...members].filter(([k]) => k !== id).map(([, v]) => v.name)].map((n) => n.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const n = `${name.slice(0, 26)} ${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }

  function admit(c, m) {
    const id = String(m.id || '');
    if (!/^[0-9a-f]{16,40}$/.test(id) || id === me.id) { try { c.close(); } catch { /* */ } return null; }
    const existing = members.get(id);
    if (!existing && members.size + 1 >= MAX_MEMBERS) {
      try { c.send({ t: 'full', max: MAX_MEMBERS }); } catch { /* */ }
      setTimeout(() => { try { c.close(); } catch { /* */ } }, 500);
      return null;
    }
    const name = uniqueName(cleanName(m.name) || 'Anonymous', id);
    members.set(id, { conn: c, name, lastSeen: Date.now() });
    if (existing) { try { existing.conn.close(); } catch { /* */ } }
    roster = existing ? roster.map((x) => (x.id === id ? { id, name } : x)) : [...roster, { id, name }];
    c.send({ t: 'welcome', you: id, name, host: me.id, members: roster });
    broadcastRoster();
    if (!existing && !m.rejoin) broadcast({ t: 'joined', id, name }, id);
    return id;
  }

  function dropMember(id, c) {
    if (role !== 'host') return;
    const mem = members.get(id);
    if (!mem || (c && mem.conn !== c)) return;
    members.delete(id);
    try { mem.conn.close(); } catch { /* */ }
    roster = roster.filter((x) => x.id !== id);
    for (const rec of receipts.values()) {
      if (rec.recips.delete(id)) { rec.d.delete(id); rec.r.delete(id); markDirty(rec); }
    }
    for (const [fid, f] of relays) {
      if (f.from === id) {
        relays.delete(fid);
        for (const r of f.recips) deliver(r, { t: 'file-cancel', id: fid, reason: 'sender-left' });
      } else f.recips.delete(id);
    }
    broadcast({ t: 'typing', from: id, name: mem.name, on: false });
    broadcast({ t: 'left', id, name: mem.name });
    broadcastRoster();
  }

  // Send to one member; the hub "sends" to itself by handling the message locally.
  function deliver(id, msg) {
    if (id === me.id) { onData(msg); return true; }
    const mem = members.get(id);
    if (!mem || !mem.conn.open) return false;
    try { mem.conn.send(msg); return true; } catch { return false; }
  }
  function broadcast(msg, exceptId) {
    if (exceptId !== me.id) onData(msg);
    for (const [id, mem] of members) {
      if (id !== exceptId && mem.conn.open) { try { mem.conn.send(msg); } catch { /* heartbeat drops it */ } }
    }
  }
  const broadcastRoster = () => broadcast({ t: 'roster', host: me.id, members: roster });
  const othersThan = (id) => [me.id, ...members.keys()].filter((x) => x !== id);

  // Everything a member (or the hub itself) sends goes through here.
  function hostHandle(from, m) {
    switch (m.t) {
      case 'msg': {
        const text = String(m.text ?? '').slice(0, 20000);
        const id = String(m.id || '').slice(0, 40);
        if (!text || !id) return;
        const recips = othersThan(from);
        trackReceipt(id, from, recips);
        const out = { t: 'msg', id, text, from, name: nameOf(from) };
        for (const r of recips) deliver(r, out);
        break;
      }
      case 'typing': broadcast({ t: 'typing', from, name: nameOf(from), on: !!m.on }, from); break;
      case 'ack': applyAcks(from, m.s, m.ids); break;
      case 'file-start': relayStart(from, m); break;
      case 'file-chunk': relayChunk(from, m); break;
      case 'file-end': relayEnd(from, m, 'file-end'); break;
      case 'file-cancel': relayEnd(from, m, 'file-cancel'); break;
      case 'bye': if (from !== me.id) dropMember(from); break;
      default: // 'ping' keep-alives
    }
  }

  function relayStart(from, m) {
    const id = String(m.id || '').slice(0, 40);
    if (!id || relays.has(id)) return;
    const recips = new Set(othersThan(from));
    relays.set(id, { id, from, recips, count: 0, chain: Promise.resolve() });
    trackReceipt(id, from, [...recips]);
    const out = {
      t: 'file-start', id, from, name: nameOf(from),
      fname: String(m.name || 'file').slice(0, 200), size: Math.max(0, Number(m.size) || 0),
      mime: safeMime(m.mime), voice: !!m.voice, dur: Math.max(0, Number(m.dur) || 0),
    };
    for (const r of recips) deliver(r, out);
  }

  function relayChunk(from, m) {
    const f = relays.get(String(m.id));
    const d = m.data;
    if (!f || f.from !== from || !(d instanceof ArrayBuffer || ArrayBuffer.isView(d))) return;
    const out = { t: 'file-chunk', id: f.id, data: d };
    for (const r of f.recips) deliver(r, out);
    f.count++;
    if (f.count % WINDOW === 0) {
      // Flow control: the sender may only run two windows ahead of the slowest member.
      const n = f.count;
      f.chain = f.chain.then(() => drainRecipients(f)).then(() => deliver(from, { t: 'credit', id: f.id, n }));
    }
  }

  function relayEnd(from, m, type) {
    const f = relays.get(String(m.id));
    if (!f || f.from !== from) return;
    relays.delete(f.id);
    for (const r of f.recips) deliver(r, { t: type, id: f.id, reason: 'cancelled' });
  }

  async function drainRecipients(f) {
    for (const r of [...f.recips]) {
      const mem = members.get(r);
      const dc = mem && mem.conn.dataChannel;
      if (!dc) continue;
      const t0 = Date.now();
      while (dc.bufferedAmount > RELAY_LOW && mem.conn.open && f.recips.has(r) && members.get(r) === mem) {
        if (Date.now() - t0 > SLOW_MEMBER_MS) {
          // Don't let one slow phone hold up the whole group.
          f.recips.delete(r);
          const rec = receipts.get(f.id);
          if (rec && rec.recips.delete(r)) markDirty(rec);
          deliver(r, { t: 'file-cancel', id: f.id, reason: 'slow' });
          break;
        }
        await drained(dc, 2000);
      }
    }
  }

  // Delivered / read receipts are aggregated here and sent to the author as counts.
  const dirty = new Set();
  let rcptTimer = 0;
  function trackReceipt(id, from, recips) {
    receipts.set(id, { id, from, recips: new Set(recips), d: new Set(), r: new Set() });
    if (receipts.size > 2000) receipts.delete(receipts.keys().next().value);
  }
  function applyAcks(from, s, ids) {
    if (!Array.isArray(ids)) return;
    for (const raw of ids.slice(0, 1000)) {
      const rec = receipts.get(String(raw));
      if (!rec || !rec.recips.has(from)) continue;
      const before = rec.d.size + rec.r.size;
      rec.d.add(from);
      if (s === 'r') rec.r.add(from);
      if (rec.d.size + rec.r.size !== before) markDirty(rec);
    }
  }
  function markDirty(rec) { dirty.add(rec); if (!rcptTimer) rcptTimer = setTimeout(flushRcpts, 500); }
  function flushRcpts() {
    rcptTimer = 0;
    if (role === 'host') {
      for (const rec of dirty) deliver(rec.from, { t: 'rcpt', id: rec.id, d: rec.d.size, r: rec.r.size, total: rec.recips.size });
    }
    dirty.clear();
  }

  // ---------------------------------------------------------------- member (guest) side
  async function joinRoom() {
    const r = readForm();
    if (!r) return;
    primeAlerts();
    teardown();
    resetChat();
    room = r; role = 'guest';
    setBusy(ui.join);
    homeStatus(`Looking for #${r}…`);
    try {
      await connectToHub(false, JOIN_TIMEOUT);
    } catch (e) {
      if (role !== 'guest' || room !== r || e.code === 'left') return;
      teardown();
      setBusy(null);
      homeStatus(
        e.code === 'unavailable' ? `#${r} isn't open right now. Ask someone in it for the link, or create it yourself.`
          : e.code === 'full' ? `#${r} is full (${MAX_MEMBERS} people). Try again later.`
            : e.code === 'timeout' ? `Couldn't connect to #${r}. A strict network or firewall may be blocking peer-to-peer.`
              : peerErrorText(e),
        'err');
    }
  }

  async function connectToHub(rejoin, timeout) {
    if (!peer || peer.destroyed) peer = await openPeer();
    else if (peer.disconnected) { try { peer.reconnect(); } catch { /* */ } }
    const p = peer;
    settleJoin(err('left'));
    return new Promise((resolve, reject) => {
      const c = p.connect(PREFIX + room, { reliable: true, serialization: 'binary' });
      pendingJoin = { c, resolve, reject, timer: setTimeout(() => settleJoin(err('timeout')), timeout) };
      c.on('open', () => { try { c.send({ t: 'join', id: me.id, name: me.name, rejoin }); } catch { /* */ } });
      c.on('data', (m) => onGuestData(c, m));
      c.on('close', () => {
        if (conn === c) hostLost();
        else if (pendingJoin && pendingJoin.c === c) settleJoin(err('timeout'));
      });
      c.on('error', () => { /* close follows */ });
    });
  }

  function settleJoin(e, welcome) {
    const pj = pendingJoin;
    if (!pj) return;
    pendingJoin = null;
    clearTimeout(pj.timer);
    if (e) { try { pj.c.close(); } catch { /* */ } pj.reject(e); }
    else pj.resolve(welcome);
  }

  function onGuestData(c, m) {
    if (!m || typeof m !== 'object') return;
    if (conn !== c) {
      if (!pendingJoin || pendingJoin.c !== c) return;
      if (m.t === 'full') { settleJoin(err('full')); return; }
      if (m.t !== 'welcome') return;
      conn = c;
      hostLastSeen = Date.now();
      settleJoin(null, m);
      onWelcome(c, m);
      return;
    }
    hostLastSeen = Date.now();
    if (connState === 'unstable') { connState = 'online'; renderPresence(); }
    onData(m);
  }

  function onWelcome(c, m) {
    const previousHost = hostId;
    epoch++;
    stopRecovery();
    watchIce(c, () => { if (conn === c) hostLost(); });
    me.name = cleanName(m.name) || me.name;
    connState = 'online';
    keepAlive(true); setUrl(room); setBusy(null); homeStatus('');
    enterChat();
    applyRoster({ host: m.host, members: m.members }, true);
    if (!everJoined) sys(`You joined #${room} as ${me.name}. Earlier messages aren't available: nothing is ever stored.`, 'lock');
    else if (previousHost && previousHost !== hostId) sys(`Reconnected. ${nameOf(hostId)} is now hosting the group.`, 'crown');
    else sys('Reconnected to the group.', 'lock');
    everJoined = true;
    setBanner(null);
    refreshChrome();
    if (!coarse) ui.input.focus({ preventScroll: true });
  }

  // The hub went away (left, crashed, lost network). Reconnect, or take over.
  function hostLost() {
    if (role !== 'guest' || !conn) return;
    const c = conn;
    conn = null;
    try { c.close(); } catch { /* */ }
    epoch++; wakeCredits(); clearTypers();
    failIncoming('Interrupted');
    const oldHost = hostId;
    const remaining = roster.filter((x) => x.id !== oldHost);
    const rank = Math.max(0, remaining.findIndex((x) => x.id === me.id));
    sys(`${nameOf(oldHost)} (host) left. Reconnecting the group…`, 'alert', true);
    startRecovery(rank);
  }

  function startRecovery(rank) {
    stopRecovery();
    recovery = { rank, start: Date.now(), tries: 0, timer: 0, busy: false };
    connState = 'reconnecting';
    setBanner('Reconnecting to the group…', false);
    refreshChrome();
    recoveryStep();
  }
  function stopRecovery() { if (recovery) clearTimeout(recovery.timer); recovery = null; }

  async function recoveryStep() {
    const r = recovery;
    if (!r || r.busy) return;
    r.timer = 0;
    const elapsed = Date.now() - r.start;
    if (elapsed > RECOVERY_MS) {
      recovery = null;
      connState = 'offline';
      setBanner(`Couldn't reconnect to #${room}.`, true);
      refreshChrome();
      return;
    }
    r.busy = true;
    r.tries++;
    // The next member in join order claims the room first; others give them a short
    // head start, then also try (members ahead of them may be asleep or gone).
    const claim = elapsed >= Math.min(r.rank * CLAIM_STAGGER, CLAIM_MAX_WAIT) && r.tries % 2 === 1;
    try {
      if (claim) {
        const p = await openPeer(PREFIX + room);
        if (recovery !== r) { p.destroy(); return; }
        becomeHost(p, false);
        return;
      }
      await connectToHub(true, RECONNECT_TRY_MS);
      return;
    } catch { /* nobody there yet, or someone else won the claim: try again */ }
    finally { r.busy = false; }
    if (recovery === r) r.timer = setTimeout(recoveryStep, 1200 + Math.random() * 1500);
  }

  function demoteToGuest() {
    if (role !== 'host') return;
    const ms = [...members.values()];
    members.clear(); relays.clear(); receipts.clear();
    ms.forEach((m) => { try { m.conn.close(); } catch { /* */ } });
    const p = peer;
    peer = null;
    try { p && p.destroy(); } catch { /* */ }
    role = 'guest'; conn = null;
    epoch++; wakeCredits(); clearTypers();
    sys('Lost the connection to the group. Reconnecting…', 'alert', true);
    startRecovery(Infinity); // connect to whoever took over; claim only as a late fallback
  }

  // ---------------------------------------------------------------- leaving
  function teardown() {
    epoch++; wakeCredits(); stopRecovery();
    settleJoin(err('left'));
    const p = peer, c = conn, ms = [...members.values()];
    if (role === 'host') ms.forEach((m) => { try { m.conn.send({ t: 'bye' }); } catch { /* */ } });
    else if (c && c.open) { try { c.send({ t: 'bye' }); } catch { /* */ } }
    peer = null; conn = null; role = null;
    members.clear(); relays.clear(); receipts.clear();
    clearTimeout(rcptTimer); rcptTimer = 0; dirty.clear();
    // Give the goodbyes a moment to flush before tearing the connections down.
    setTimeout(() => {
      ms.forEach((m) => { try { m.conn.close(); } catch { /* */ } });
      try { c && c.close(); } catch { /* */ }
      try { p && p.destroy(); } catch { /* */ }
    }, 200);
    stopRecording(false);
    keepAlive(false);
  }

  function leave(msg = 'You left the room. Nothing was saved.') {
    teardown();
    resetChat();
    closeOverlays();
    setUrl(null);
    setBusy(null);
    show('home');
    homeStatus(msg);
  }

  function confirmLeave() {
    if (ui.list.querySelector('.row') && !confirm('Leave this room? The conversation will be gone from this device.')) return;
    leave();
  }
  ui.leave.addEventListener('click', confirmLeave);
  ui.bannerLeave.addEventListener('click', () => leave());
  ui.rejoin.addEventListener('click', () => { if (role === 'guest') startRecovery(0); });

  // ---------------------------------------------------------------- chat chrome
  function enterChat() {
    ui.roomTitle.textContent = `#${room}`;
    ui.emptyCode.textContent = `#${room}`;
    paintAvatar(ui.roomAvatar, room.replace(/[-_]+/g, ' '), room);
    ui.sideTitle.textContent = `#${room}`;
    paintAvatar(ui.sideAvatar, room.replace(/[-_]+/g, ' '), room);
    show('chat');
    measureChrome();
  }

  function applyRoster(m, quiet) {
    if (!Array.isArray(m.members)) return;
    const prevHost = hostId;
    roster = m.members.slice(0, MAX_MEMBERS + 5).map((x) => ({ id: String(x.id), name: cleanName(x.name) || 'Anonymous' }));
    hostId = String(m.host);
    if (!quiet && prevHost && prevHost !== hostId && everJoined) sys(`${nameOf(hostId)} is now hosting the group.`, 'crown');
    for (const id of [...typers.keys()]) if (!roster.some((x) => x.id === id)) setTyper(id, '', false);
    refreshChrome();
  }

  function refreshChrome() {
    ui.memberCount.textContent = Math.max(1, roster.length);
    ui.drawerCount.textContent = `· ${roster.length}`;
    renderPresence();
    if (!ui.drawer.hidden) renderMembers();
    renderSideMembers();
    updateEmpty();
    setComposer(canSend());
  }
  function updateEmpty() { ui.empty.hidden = !(role === 'host' && roster.length <= 1 && !ui.list.querySelector('.row')); }

  function typingText() {
    const n = [...typers.values()].map((t) => t.name);
    if (n.length === 1) return `${n[0]} is typing`;
    if (n.length === 2) return `${n[0]} and ${n[1]} are typing`;
    return `${n[0]}, ${n[1]} and ${n.length - 2} other${n.length > 3 ? 's' : ''} are typing`;
  }

  function renderPresence() {
    let state = 'online', text;
    if (connState === 'reconnecting') { state = 'reconnecting'; text = 'Reconnecting to the group…'; }
    else if (connState === 'offline') { state = 'offline'; text = 'Disconnected'; }
    else if (connState === 'unstable') { state = 'unstable'; text = 'Connection unstable…'; }
    else if (typers.size) { state = 'typing'; text = `${typingText()}…`; }
    else {
      const others = roster.filter((x) => x.id !== me.id).map((x) => x.name);
      if (!others.length) { state = 'alone'; text = 'Only you so far · invite people'; }
      else if (others.length <= 3) text = `You, ${others.join(', ')}`;
      else text = `${roster.length} members · You, ${others.slice(0, 2).join(', ')} and ${others.length - 2} others`;
    }
    ui.presence.dataset.state = state;
    ui.presence.textContent = text;
  }

  function setBanner(text, canRejoin) {
    ui.banner.hidden = !text;
    if (!text) return;
    ui.bannerText.textContent = text;
    ui.rejoin.hidden = !canRejoin;
  }
  function setComposer(on) {
    ui.composer.classList.toggle('off', !on);
    ui.input.disabled = !on;
    ui.attach.disabled = !on;
    ui.send.disabled = !on;
  }

  function resetChat() {
    ui.list.replaceChildren();
    for (const it of outgoing) it.cancelled = true;
    outgoing.clear(); incoming.clear(); sent.clear(); credits.clear(); pendingRead.clear();
    ackQueue.d.clear(); ackQueue.r.clear();
    objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    if (currentAudio) currentAudio.pause();
    sendQueue = Promise.resolve();
    lastKey = null; everJoined = false; roster = []; hostId = null; connState = 'online';
    clearTypers();
    unread = 0; updateTitle();
    jumpN = 0; ui.jump.hidden = true;
    ui.input.value = ''; autoGrow(); updateSendBtn();
    ui.memberSearch.value = '';
    setBanner(null);
    ui.sideSearch.value = '';
    setPreview('Room is open', 0);
    qrFor = '';
  }

  // ---------------------------------------------------------------- members drawer + invite sheet
  function memberItems(target, query) {
    const q = query.trim().toLowerCase();
    const list = roster.filter((x) => !q || x.name.toLowerCase().includes(q));
    target.replaceChildren(...list.map((x) => {
      const li = h('li');
      const av = h('span', 'avatar');
      paintAvatar(av, x.name, x.id);
      const nm = h('span', 'mname', x.name);
      if (x.id === me.id) nm.append(h('span', 'you-tag', ' (you)'));
      li.append(av, nm);
      if (x.id === hostId) { const tag = h('span', 'tag'); tag.innerHTML = icon('crown'); tag.append('Host'); li.append(tag); }
      return li;
    }));
    if (!list.length) target.append(h('li', 'member-empty', q ? 'No one matches that name.' : 'No one here yet.'));
  }
  function renderMembers() {
    memberItems(ui.memberList, ui.memberSearch.value);
    ui.drawerCount.textContent = `· ${roster.length}`;
  }
  function renderSideMembers() {
    memberItems(ui.sideMembers, ui.sideSearch.value);
    ui.sideCount.textContent = `· ${roster.length}`;
  }
  // Last message shown under the room in the sidebar, like a chat list.
  function setPreview(text, ts) {
    ui.sidePreview.textContent = text;
    ui.sideTime.textContent = ts ? fmtTime(ts) : '';
  }
  function openMembers() { renderMembers(); ui.drawer.hidden = false; if (!coarse) ui.memberSearch.focus(); }
  function closeMembers() { ui.drawer.hidden = true; }
  ui.membersBtn.addEventListener('click', openMembers);
  ui.who.addEventListener('click', openMembers);
  ui.drawerClose.addEventListener('click', closeMembers);
  ui.drawer.addEventListener('click', (e) => { if (e.target === ui.drawer) closeMembers(); });
  ui.memberSearch.addEventListener('input', renderMembers);
  ui.sideSearch.addEventListener('input', renderSideMembers);

  let qrFor = '';
  function openInvite() {
    const link = inviteLink();
    ui.inviteCode.textContent = `#${room}`;
    ui.inviteLink.textContent = link;
    if (qrFor !== link) {
      ui.qr.replaceChildren();
      if (window.QRCode) {
        try { new QRCode(ui.qr, { text: link, width: 148, height: 148, colorDark: '#1B1916', colorLight: '#FFFFFF', correctLevel: QRCode.CorrectLevel.M }); }
        catch { ui.qr.replaceChildren(); }
      }
      qrFor = link;
    }
    closeMembers();
    ui.inviteModal.hidden = false;
    ui.inviteClose.focus();
  }
  const closeInvite = () => { ui.inviteModal.hidden = true; };
  function closeOverlays() { closeMembers(); closeInvite(); closeLightbox(); }
  [ui.inviteBtn, ui.emptyInvite, ui.drawerInvite, ui.sideInvite].forEach((b) => b.addEventListener('click', openInvite));
  ui.inviteClose.addEventListener('click', closeInvite);
  ui.inviteModal.addEventListener('click', (e) => { if (e.target === ui.inviteModal) closeInvite(); });
  ui.copyLink.addEventListener('click', () => copy(inviteLink(), 'Invite link copied'));
  ui.emptyCopy.addEventListener('click', () => copy(inviteLink(), 'Invite link copied'));
  ui.share.addEventListener('click', async () => {
    const link = inviteLink();
    if (navigator.share) {
      try { await navigator.share({ title: 'iText Chat', text: `Join #${room} on iText Chat`, url: link }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    copy(link, 'Invite link copied');
  });

  // ---------------------------------------------------------------- scrolling
  let jumpN = 0;
  const nearBottom = () => ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 140;
  function scrollBottom(smooth) { ui.messages.scrollTo({ top: ui.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }
  // Remembered across resizes (e.g. the phone keyboard opening), which change the distance to the bottom without scrolling.
  let pinned = true;
  ui.messages.addEventListener('scroll', () => { pinned = nearBottom(); if (pinned) { jumpN = 0; ui.jump.hidden = true; } }, { passive: true });
  ui.jump.addEventListener('click', () => scrollBottom(true));
  function place(row, mine) {
    const stick = nearBottom();
    ui.list.append(row);
    updateEmpty();
    if (stick || mine) scrollBottom();
    else { jumpN++; ui.jumpCount.textContent = jumpN > 99 ? '99+' : jumpN; ui.jump.hidden = false; }
  }
  function measureChrome() {
    const stick = pinned || nearBottom();
    ui.pane.style.setProperty('--head-h', `${ui.chatHead.offsetHeight}px`);
    ui.pane.style.setProperty('--comp-h', `${ui.composer.offsetHeight}px`);
    ui.pane.style.setProperty('--sb', `${ui.messages.offsetWidth - ui.messages.clientWidth}px`);
    if (stick) scrollBottom();
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(measureChrome);
    ro.observe(ui.composer);
    ro.observe(ui.chatHead);
    ro.observe(ui.messages);
  }
  addEventListener('resize', () => { measureChrome(); setTimeout(measureChrome, 150); });
  function keepPinned() { if (ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 500) scrollBottom(); }

  // ---------------------------------------------------------------- message rendering
  let lastKey = null, lastTs = 0;

  // Consecutive messages from the same person within 2 minutes are grouped:
  // only the first shows their avatar and name.
  function newRow(from, mine, ts, senderName) {
    const key = mine ? me.id : from;
    const row = h('div', `row ${mine ? 'me' : 'them'}`);
    const cont = key === lastKey && ts - lastTs < 120000;
    if (cont) row.classList.add('cont');
    lastKey = key; lastTs = ts;
    if (!mine) { const av = h('span', 'avatar mav'); paintAvatar(av, senderName, from); row.append(av); }
    const bubble = h('div', 'bubble');
    if (!mine && !cont) {
      const s = h('span', 'sender', senderName);
      s.style.setProperty('--hue', hash(from) % 360);
      bubble.append(s);
    }
    row.append(bubble);
    return { row, bubble };
  }

  function metaEl(ts, mine) {
    const m = h('span', 'meta');
    m.append(h('time', '', fmtTime(ts)));
    let tick = null;
    if (mine) { tick = h('span', 'tick'); m.append(tick); }
    return { m, tick };
  }

  const TICK_RANK = { sending: 0, sent: 1, d: 2, r: 3 };
  const TICK_LABEL = { sending: 'Sending', sent: 'Sent', d: 'Delivered to everyone', r: 'Read by everyone' };
  function setTick(rec, state) {
    if (!rec || (rec.state && TICK_RANK[state] <= TICK_RANK[rec.state])) return;
    rec.state = state;
    rec.tick.className = `tick ${state}`;
    rec.tick.title = TICK_LABEL[state];
    rec.tick.innerHTML = icon(state === 'sending' ? 'clock' : state === 'sent' ? 'check' : 'check2');
  }
  function updateReceipt(m) {
    const rec = sent.get(String(m.id));
    const total = Number(m.total) || 0, d = Number(m.d) || 0, r = Number(m.r) || 0;
    if (!rec || !total) return;
    if (r >= total) setTick(rec, 'r');
    else if (d >= total) setTick(rec, 'd');
    rec.tick.title = r >= total ? (total === 1 ? 'Read' : `Read by all ${total}`) : `Delivered to ${d} of ${total} · Read by ${r} of ${total}`;
  }

  function sys(text, iconName = 'lock', warn = false) {
    const d = h('div', `sys${warn ? ' warn' : ''}`);
    d.innerHTML = icon(iconName);
    d.append(text);
    lastKey = null;
    place(d, false);
  }

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
  function linkify(el, text) {
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      el.append(text.slice(last, m.index));
      const a = h('a', '', m[0]);
      a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      el.append(a);
      last = m.index + m[0].length;
    }
    el.append(text.slice(last));
  }
  const JUMBO_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,16}$/u;
  const isJumbo = (t) => t.length <= 16 && JUMBO_RE.test(t) && /\p{Extended_Pictographic}/u.test(t);

  function addText({ id, text, ts, mine, from, name }) {
    const { row, bubble } = newRow(from, mine, ts, name);
    setPreview(`${mine ? 'You' : name}: ${text.replace(/s+/g, ' ').trim()}`, ts);
    const t = h('div', 'text');
    if (isJumbo(text.trim())) t.classList.add('jumbo');
    linkify(t, text);
    const { m, tick } = metaEl(ts, mine);
    bubble.append(t, m);
    place(row, mine);
    if (mine) { const rec = { tick, state: null }; sent.set(id, rec); setTick(rec, 'sending'); }
    // Invisible copy of the timestamp at the end of the text reserves exactly
    // enough room on the last line for the real (absolutely placed) one.
    const ghost = m.cloneNode(true);
    ghost.className = 'meta ghost';
    ghost.setAttribute('aria-hidden', 'true');
    t.append(ghost);
  }

  // ---------------------------------------------------------------- attachments
  const SAFE_MIME = /^[a-z]+\/[a-z0-9.+-]+(;[ a-z0-9=.+-]*)*$/i;
  const safeMime = (m) => (typeof m === 'string' && m.length < 120 && SAFE_MIME.test(m)) ? m : '';
  function kindOf(mime, voice) {
    if (/^audio\//i.test(mime)) return voice ? 'voice' : 'audio';
    if (/^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime)) return 'image';
    if (/^video\/(mp4|webm|ogg|quicktime)$/i.test(mime)) return 'video';
    return 'file';
  }
  const isVisual = (k) => k === 'image' || k === 'video';
  const KIND_ICON = { image: 'image', video: 'video', audio: 'music', voice: 'mic', file: 'file' };
  const KIND_LABEL = { image: '📷 Photo', video: '🎬 Video', audio: '🎵 Audio', voice: '🎤 Voice message' };
  const extOf = (name) => { const m = /\.([a-z0-9]{1,6})$/i.exec(name); return m ? m[1] : 'file'; };

  function fileCard(a, url) {
    const card = h('div', 'filecard');
    const ic = h('div', 'fileicon');
    ic.innerHTML = icon(KIND_ICON[a.kind] || 'file');
    ic.append(h('b', '', extOf(a.name)));
    const info = h('div', 'fileinfo');
    info.append(h('strong', '', a.name), h('span', '', fmtSize(a.size)));
    info.firstChild.title = a.name;
    card.append(ic, info);
    if (url) {
      const dl = h('a', 'dl');
      dl.href = url; dl.download = a.name; dl.title = `Download ${a.name}`;
      dl.setAttribute('aria-label', `Download ${a.name}`);
      dl.innerHTML = icon('download');
      card.append(dl);
    }
    return card;
  }

  function placeholder(a) {
    if (isVisual(a.kind)) { const p = h('div', 'ph'); p.innerHTML = icon(KIND_ICON[a.kind]); return p; }
    return fileCard(a, null);
  }

  function buildMedia(a, url) {
    if (a.kind === 'image') {
      const b = h('button', 'media-btn');
      b.type = 'button';
      b.setAttribute('aria-label', `Open ${a.name}`);
      const img = new Image();
      img.alt = a.name; img.src = url; img.decoding = 'async';
      img.addEventListener('load', keepPinned, { once: true });
      b.append(img);
      b.addEventListener('click', () => openLightbox(url, a.name));
      return b;
    }
    if (a.kind === 'video') {
      const v = h('video');
      v.src = url; v.controls = true; v.playsInline = true; v.preload = 'metadata';
      v.addEventListener('loadedmetadata', keepPinned, { once: true });
      return v;
    }
    if (a.kind === 'voice') return player(url, a, true);
    if (a.kind === 'audio') {
      const wrap = h('div');
      const title = h('div', 'audio-title');
      title.innerHTML = icon('music');
      title.append(h('span', '', a.name));
      const dl = h('a', 'dl');
      dl.href = url; dl.download = a.name; dl.title = 'Download'; dl.innerHTML = icon('download');
      dl.style.cssText = 'width:28px;height:28px;margin-left:auto';
      title.append(dl);
      wrap.append(title, player(url, a, false));
      return wrap;
    }
    return fileCard(a, url);
  }

  // One bubble for any attachment, sent or received. Returns a small view API.
  function renderAttachment(a) {
    const { row, bubble } = newRow(a.from, a.mine, a.ts, a.sender);
    setPreview(`${a.mine ? 'You' : a.sender}: ${KIND_LABEL[a.kind] || a.name || 'File'}`, a.ts);
    bubble.classList.add('att', 'busy');
    if (isVisual(a.kind)) bubble.classList.add('visual');
    const body = h('div', 'att-body');
    body.append(a.url ? buildMedia(a, a.url) : placeholder(a));

    const xfer = h('div', 'xfer');
    const bar = h('div', 'bar'); const fill = h('i'); bar.append(fill);
    const label = h('span', 'xfer-label', a.mine ? 'Queued' : 'Receiving…');
    xfer.append(bar, label);
    let cancelBtn = null;
    if (a.mine) {
      cancelBtn = h('button', 'x');
      cancelBtn.type = 'button'; cancelBtn.title = 'Cancel'; cancelBtn.setAttribute('aria-label', 'Cancel sending');
      cancelBtn.innerHTML = icon('x');
      cancelBtn.addEventListener('click', () => { a.cancelled = true; const c = credits.get(a.id); if (c) wake(c); });
      xfer.append(cancelBtn);
    }

    const { m, tick } = metaEl(a.ts, a.mine);
    bubble.append(body, xfer, m);
    place(row, a.mine);

    let rec = null;
    if (a.mine) { rec = { tick, state: null }; sent.set(a.id, rec); setTick(rec, 'sending'); }

    return {
      progress(n) {
        const p = a.size ? Math.min(1, n / a.size) : 1;
        fill.style.width = `${(p * 100).toFixed(1)}%`;
        label.textContent = `${Math.floor(p * 100)}% · ${fmtSize(n)}`;
      },
      done(url) {
        xfer.remove();
        bubble.classList.remove('busy');
        if (url) body.replaceChildren(buildMedia(a, url));
        if (rec) setTick(rec, 'sent');
        keepPinned();
      },
      fail(msg) {
        xfer.classList.add('err');
        bar.remove();
        if (cancelBtn) cancelBtn.remove();
        label.textContent = msg;
      },
    };
  }

  function failIncoming(msg) {
    for (const [id, f] of incoming) { f.a.view.fail(msg); incoming.delete(id); }
  }

  // ---------------------------------------------------------------- audio player
  let currentAudio = null;
  let offline = null;
  function pseudoPeaks(seed, n) {
    let x = hash(seed) || 1;
    return Array.from({ length: n }, () => { x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0; return 0.2 + (x % 1000) / 1000 * 0.7; });
  }
  async function analyse(blob, n) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx || !blob || blob.size > 30 * 1024 * 1024) return null;
    offline = offline || new Ctx(1, 2, 44100);
    const ab = await blob.arrayBuffer();
    const buf = await new Promise((res, rej) => { const r = offline.decodeAudioData(ab, res, rej); if (r && r.then) r.then(res, rej); });
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / n));
    const peaks = [];
    let max = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (let j = i * step, end = Math.min(data.length, j + step); j < end; j += 8) { sum += Math.abs(data[j]); count++; }
      const v = count ? sum / count : 0;
      peaks.push(v);
      if (v > max) max = v;
    }
    return { peaks: peaks.map((v) => Math.max(0.12, max ? v / max : 0.12)), duration: buf.duration };
  }

  function player(url, a, voice) {
    const wrap = h('div', 'player');
    const btn = h('button', 'pbtn');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Play');
    btn.innerHTML = icon('play', 'i-play') + icon('pause', 'i-pause');
    const wave = h('div', 'wave');
    const bars = pseudoPeaks(a.id, WAVE_BARS).map((v) => { const b = h('b'); b.style.setProperty('--h', v); wave.append(b); return b; });
    const side = h('div', 'pside');
    const time = h('span', 'ptime', fmtDur(a.dur));
    side.append(time);
    let speedBtn = null;
    if (voice) { speedBtn = h('button', 'speed', '1×'); speedBtn.type = 'button'; speedBtn.title = 'Playback speed'; side.append(speedBtn); }
    wrap.append(btn, wave, side);

    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = url;
    let duration = a.dur || 0;
    const setDur = (d) => { if (isFinite(d) && d > 0) { duration = d; if (audio.paused && !audio.currentTime) time.textContent = fmtDur(d); } };
    const paint = () => {
      const k = duration ? Math.round(Math.min(1, audio.currentTime / duration) * WAVE_BARS) : 0;
      bars.forEach((b, i) => b.classList.toggle('on', i < k));
    };
    audio.addEventListener('loadedmetadata', () => setDur(audio.duration));
    audio.addEventListener('durationchange', () => setDur(audio.duration));
    audio.addEventListener('timeupdate', () => {
      paint();
      time.textContent = fmtDur(audio.paused && !audio.currentTime ? duration : audio.currentTime);
    });
    audio.addEventListener('play', () => { wrap.classList.add('playing'); btn.setAttribute('aria-label', 'Pause'); });
    audio.addEventListener('pause', () => { wrap.classList.remove('playing'); btn.setAttribute('aria-label', 'Play'); });
    audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); time.textContent = fmtDur(duration); });
    btn.addEventListener('click', () => {
      if (!audio.paused) { audio.pause(); return; }
      if (currentAudio && currentAudio !== audio) currentAudio.pause();
      currentAudio = audio;
      audio.play().catch(() => toast('This browser cannot play that audio format'));
    });
    wave.addEventListener('click', (e) => {
      if (!duration) return;
      const r = wave.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
      paint();
    });
    if (speedBtn) {
      const speeds = [1, 1.5, 2];
      let si = 0;
      speedBtn.addEventListener('click', () => { si = (si + 1) % speeds.length; audio.playbackRate = speeds[si]; speedBtn.textContent = `${speeds[si]}×`; });
    }
    analyse(a.blob, WAVE_BARS).then((res) => {
      if (!res) return;
      res.peaks.forEach((v, i) => bars[i].style.setProperty('--h', v));
      setDur(res.duration);
    }).catch(() => { /* keep the placeholder waveform */ });
    return wrap;
  }

  // ---------------------------------------------------------------- lightbox
  function openLightbox(url, name) {
    ui.lbImg.src = url; ui.lbImg.alt = name;
    ui.lbName.textContent = name;
    ui.lbDownload.href = url; ui.lbDownload.download = name;
    ui.lightbox.hidden = false;
    ui.lbClose.focus();
  }
  function closeLightbox() { ui.lightbox.hidden = true; ui.lbImg.removeAttribute('src'); }
  ui.lbClose.addEventListener('click', closeLightbox);
  ui.lightbox.addEventListener('click', (e) => { if (e.target === ui.lightbox) closeLightbox(); });

  // ---------------------------------------------------------------- sending
  // Guests send to the hub; the hub hands its own messages to the relay directly.
  function emit(msg) {
    if (role === 'host') { hostHandle(me.id, msg); return true; }
    if (role === 'guest' && conn && conn.open) { try { conn.send(msg); return true; } catch { return false; } }
    return false;
  }

  function sendText() {
    const text = ui.input.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    if (!canSend()) { toast('Not connected right now'); return; }
    const id = uid(), ts = Date.now();
    addText({ id, text, ts, mine: true });
    if (emit({ t: 'msg', id, text })) setTick(sent.get(id), 'sent');
    ui.input.value = '';
    autoGrow(); updateSendBtn(); stopTyping();
  }

  function queueFiles(files, opts) { for (const f of files) queueFile(f, opts); }
  function queueFile(file, opts = {}) {
    if (!canSend()) { toast('Not connected right now'); return; }
    const mime = file.type || '';
    const item = {
      id: uid(), file, blob: file, name: file.name || 'file', size: file.size, mime,
      voice: !!opts.voice, dur: opts.dur || 0, ts: Date.now(), mine: true, from: me.id, sender: me.name, cancelled: false,
    };
    item.kind = kindOf(mime, item.voice);
    item.url = track(URL.createObjectURL(file));
    item.view = renderAttachment(item);
    outgoing.add(item);
    sendQueue = sendQueue.then(() => sendFile(item)).catch((e) => { console.error(e); item.view.fail('Failed to send'); });
  }

  const wake = (c) => { if (c.wake) { const w = c.wake; c.wake = null; w(); } };
  const wakeCredits = () => credits.forEach(wake);

  async function sendFile(item) {
    const myEpoch = epoch;
    const lost = () => epoch !== myEpoch || !canSend();
    const credit = { n: 0, wake: null };
    credits.set(item.id, credit);
    try {
      if (item.cancelled) { item.view.fail('Cancelled'); return; }
      if (lost()) { item.view.fail('Not sent: disconnected'); return; }
      emit({ t: 'file-start', id: item.id, name: item.name, size: item.size, mime: item.mime, voice: item.voice, dur: item.dur });
      item.view.progress(0);
      for (let off = 0, k = 0; off < item.size; off += CHUNK, k++) {
        // Stay at most two flow-control windows ahead of what the hub has passed on.
        while (!lost() && !item.cancelled && k - credit.n >= 2 * WINDOW) await new Promise((res) => { credit.wake = res; });
        const dc = role === 'guest' && conn ? conn.dataChannel : null;
        while (dc && !lost() && !item.cancelled && dc.bufferedAmount > HIGH_WATER) await drained(dc, 2000);
        if (item.cancelled) { emit({ t: 'file-cancel', id: item.id }); item.view.fail('Cancelled'); return; }
        if (lost()) { item.view.fail('Not sent: disconnected'); return; }
        const data = await item.file.slice(off, off + CHUNK).arrayBuffer();
        if (lost()) { item.view.fail('Not sent: disconnected'); return; }
        emit({ t: 'file-chunk', id: item.id, data });
        item.view.progress(off + data.byteLength);
      }
      emit({ t: 'file-end', id: item.id });
      item.view.done();
    } finally {
      credits.delete(item.id);
      outgoing.delete(item);
    }
  }

  // ---------------------------------------------------------------- receiving (every member, hub included)
  function onData(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'roster':
        applyRoster(m, false);
        break;
      case 'joined': {
        if (String(m.id) === me.id) break;
        const name = cleanName(m.name) || 'Someone';
        sys(`${name} joined`, 'user-plus');
        if (roster.length <= 2) alertUser(`#${room}`, `${name} joined your room`);
        break;
      }
      case 'left':
        if (String(m.id) !== me.id) sys(`${cleanName(m.name) || 'Someone'} left`, 'logout', true);
        break;
      case 'msg': {
        const text = String(m.text ?? '').slice(0, 20000);
        const id = String(m.id || '');
        if (!text || !id) return;
        const from = String(m.from || ''), name = cleanName(m.name) || 'Someone';
        setTyper(from, name, false);
        addText({ id, text, ts: Date.now(), mine: false, from, name });
        receipt(id);
        alertUser(`${name} · #${room}`, text.length > 140 ? `${text.slice(0, 140)}…` : text);
        break;
      }
      case 'typing':
        setTyper(String(m.from || ''), cleanName(m.name) || 'Someone', !!m.on);
        break;
      case 'rcpt':
        updateReceipt(m);
        break;
      case 'credit': {
        const c = credits.get(String(m.id));
        if (c) { c.n = Math.max(c.n, Number(m.n) || 0); wake(c); }
        break;
      }
      case 'file-start': {
        const id = String(m.id || '');
        if (!id || incoming.has(id)) return;
        const mime = safeMime(m.mime);
        const a = {
          id, mine: false, ts: Date.now(), mime,
          from: String(m.from || ''), sender: cleanName(m.name) || 'Someone',
          name: String(m.fname || 'file').slice(0, 200),
          size: Math.max(0, Number(m.size) || 0),
          voice: !!m.voice, dur: Math.max(0, Number(m.dur) || 0),
        };
        a.kind = kindOf(mime, a.voice);
        setTyper(a.from, a.sender, false);
        a.view = renderAttachment(a);
        incoming.set(id, { a, parts: [], got: 0 });
        break;
      }
      case 'file-chunk': {
        const f = incoming.get(String(m.id));
        const d = m.data;
        if (!f || !(d instanceof ArrayBuffer || ArrayBuffer.isView(d))) return;
        f.parts.push(d);
        f.got += d.byteLength;
        f.a.view.progress(f.got);
        break;
      }
      case 'file-end': {
        const id = String(m.id);
        const f = incoming.get(id);
        if (!f) return;
        incoming.delete(id);
        const a = f.a;
        // Only media keeps its real type; everything else is an opaque download,
        // so nobody can smuggle a web page onto this app's origin.
        const type = a.kind === 'file' ? 'application/octet-stream' : a.mime;
        a.blob = new Blob(f.parts, { type });
        a.view.done(track(URL.createObjectURL(a.blob)));
        receipt(id);
        const what = { image: 'sent a photo', video: 'sent a video', voice: 'sent a voice message', audio: 'sent an audio file', file: `sent a file: ${a.name}` };
        alertUser(`${a.sender} · #${room}`, `${a.sender} ${what[a.kind]}`);
        break;
      }
      case 'file-cancel': {
        const id = String(m.id);
        const f = incoming.get(id);
        if (!f) break;
        incoming.delete(id);
        f.a.view.fail(m.reason === 'slow' ? 'Skipped: connection too slow for this file'
          : m.reason === 'sender-left' ? 'Sender left before it finished' : 'Cancelled by sender');
        break;
      }
      case 'bye':
        if (role === 'guest') hostLost();
        break;
      default: // 'ping' and unknown types
    }
  }

  // ---------------------------------------------------------------- typing
  let typingOut = false, typingSentAt = 0, typingIdle = 0;
  function onTypingInput() {
    if (!canSend()) return;
    const now = Date.now();
    if (!typingOut || now - typingSentAt > 3000) { emit({ t: 'typing', on: true }); typingOut = true; typingSentAt = now; }
    clearTimeout(typingIdle);
    typingIdle = setTimeout(stopTyping, 3500);
  }
  function stopTyping() {
    clearTimeout(typingIdle);
    if (typingOut) emit({ t: 'typing', on: false });
    typingOut = false;
  }
  function setTyper(id, name, on) {
    const t = typers.get(id);
    if (t) clearTimeout(t.timer);
    if (on && id && id !== me.id) typers.set(id, { name, timer: setTimeout(() => setTyper(id, name, false), 6000) });
    else typers.delete(id);
    const wasHidden = ui.typing.hidden;
    ui.typing.hidden = !typers.size;
    ui.typingLabel.textContent = typers.size ? typingText() : '';
    if (wasHidden && typers.size && nearBottom()) scrollBottom();
    renderPresence();
  }
  function clearTypers() {
    for (const t of typers.values()) clearTimeout(t.timer);
    typers.clear();
    ui.typing.hidden = true;
    renderPresence();
  }

  // ---------------------------------------------------------------- composer
  function autoGrow() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 160)}px`;
  }
  function updateSendBtn() {
    const has = !!ui.input.value.trim();
    ui.composeBar.classList.toggle('has-text', has);
    ui.send.setAttribute('aria-label', has ? 'Send message' : 'Record a voice message');
    ui.send.title = has ? 'Send' : 'Record voice message';
  }
  ui.input.addEventListener('input', () => { autoGrow(); updateSendBtn(); onTypingInput(); });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); sendText(); }
  });
  ui.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); queueFiles(files); }
  });
  ui.send.addEventListener('click', () => { if (ui.input.value.trim()) sendText(); else startRecording(); });
  ui.attach.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', () => { queueFiles([...ui.file.files]); ui.file.value = ''; });

  // ---------------------------------------------------------------- voice recording
  let rec = null;
  const SCOPE_BARS = 48;
  for (let i = 0; i < SCOPE_BARS; i++) ui.recScope.append(h('b'));

  async function startRecording() {
    if (rec) return;
    if (!canSend()) { toast('Not connected right now'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Voice messages are not supported in this browser'); return; }
    const ctx = audioCtx();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Microphone blocked. Allow mic access to send voice messages.' : 'No microphone found');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
    let mr;
    try { mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined); } catch { mr = new MediaRecorder(stream); }
    const r = rec = { mr, stream, chunks: [], start: Date.now(), raf: 0, limit: 0, src: null, analyser: null };
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.start(250);
    r.limit = setTimeout(() => { if (rec === r) stopRecording(true); }, MAX_VOICE_SEC * 1000);

    ui.composeBar.hidden = true;
    ui.recBar.hidden = false;
    ui.recTime.textContent = '0:00';
    ui.recSend.focus();

    if (ctx) {
      try {
        r.src = ctx.createMediaStreamSource(stream);
        r.analyser = ctx.createAnalyser();
        r.analyser.fftSize = 512;
        r.src.connect(r.analyser);
      } catch { r.analyser = null; }
    }
    const bars = [...ui.recScope.children];
    const levels = new Array(SCOPE_BARS).fill(0.08);
    const buf = r.analyser ? new Uint8Array(r.analyser.fftSize) : null;
    let lastPush = 0;
    const frame = (now) => {
      if (rec !== r) return;
      ui.recTime.textContent = fmtDur((Date.now() - r.start) / 1000);
      if (now - lastPush > 70) {
        lastPush = now;
        let level = 0.08;
        if (r.analyser) {
          r.analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
          level = Math.max(0.08, Math.min(1, (peak / 128) * 1.8));
        }
        levels.shift(); levels.push(level);
        bars.forEach((b, i) => b.style.setProperty('--h', levels[i]));
      }
      r.raf = requestAnimationFrame(frame);
    };
    r.raf = requestAnimationFrame(frame);
  }

  function stopRecording(send) {
    const r = rec;
    if (!r) return;
    rec = null;
    cancelAnimationFrame(r.raf);
    clearTimeout(r.limit);
    ui.recBar.hidden = true;
    ui.composeBar.hidden = false;
    const dur = (Date.now() - r.start) / 1000;
    const finish = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      try { r.src && r.src.disconnect(); } catch { /* */ }
      if (!send) return;
      if (dur < 0.6) { toast('Too short. Record a little longer.'); return; }
      const type = r.mr.mimeType || r.chunks[0]?.type || 'audio/webm';
      const blob = new Blob(r.chunks, { type });
      const ext = /mp4|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
      queueFile(new File([blob], `voice-message.${ext}`, { type }), { voice: true, dur });
    };
    if (r.mr.state === 'inactive') finish();
    else { r.mr.addEventListener('stop', finish, { once: true }); r.mr.stop(); }
    if (!coarse && view() === 'chat') ui.input.focus({ preventScroll: true });
  }
  ui.recCancel.addEventListener('click', () => stopRecording(false));
  ui.recSend.addEventListener('click', () => stopRecording(true));

  // ---------------------------------------------------------------- drag & drop, keyboard
  let dragDepth = 0;
  const canDrop = (e) => view() === 'chat' && canSend() && [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!canDrop(e)) return; e.preventDefault(); dragDepth++; ui.drop.hidden = false; });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ui.drop.hidden = true; } });
  addEventListener('dragover', (e) => { if (canDrop(e)) e.preventDefault(); });
  addEventListener('drop', (e) => {
    dragDepth = 0; ui.drop.hidden = true;
    if (!canDrop(e)) return;
    e.preventDefault();
    queueFiles([...e.dataTransfer.files]);
  });

  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!ui.lightbox.hidden) closeLightbox();
    else if (!ui.inviteModal.hidden) closeInvite();
    else if (!ui.drawer.hidden) closeMembers();
    else if (rec) stopRecording(false);
  });

  // ---------------------------------------------------------------- read receipts, alerts, unread badge
  let unread = 0;
  let actx = null;
  const FAVICON = ui.favicon.href;
  const BADGE_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#FF7447"/><path d="M14 19a6 6 0 0 1 6-6h24a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H32l-10 8v-8h-2a6 6 0 0 1-6-6z" fill="#1C0D06"/><circle cx="50" cy="14" r="12" fill="#4BD99A" stroke="#0C0F12" stroke-width="4"/></svg>');

  // Acks are batched so a busy 50-person room doesn't flood the hub.
  const ackQueue = { d: new Set(), r: new Set() };
  let ackTimer = 0;
  function receipt(id) {
    if (!document.hidden) queueAck(id, 'r');
    else { queueAck(id, 'd'); pendingRead.add(id); }
  }
  function queueAck(id, s) { ackQueue[s].add(id); if (!ackTimer) ackTimer = setTimeout(flushAcks, 400); }
  function flushAcks() {
    ackTimer = 0;
    const r = [...ackQueue.r];
    const d = [...ackQueue.d].filter((x) => !ackQueue.r.has(x));
    ackQueue.r.clear(); ackQueue.d.clear();
    if (r.length) emit({ t: 'ack', s: 'r', ids: r });
    if (d.length) emit({ t: 'ack', s: 'd', ids: d });
  }

  function updateTitle() {
    document.title = unread ? `(${unread}) iText Chat` : 'iText Chat';
    ui.favicon.href = unread ? BADGE_ICON : FAVICON;
  }
  function onActive() {
    if (document.hidden) return;
    for (const id of pendingRead) queueAck(id, 'r');
    pendingRead.clear();
    if (document.hasFocus()) { unread = 0; updateTitle(); }
    heartbeat();
  }
  document.addEventListener('visibilitychange', onActive);
  addEventListener('focus', onActive);

  function audioCtx() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { actx = null; }
    return actx;
  }
  function chime() {
    const c = actx;
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    [[880, 0], [1318.5, 0.09]].forEach(([f, d]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.1, t + d + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
      o.connect(g).connect(c.destination);
      o.start(t + d); o.stop(t + d + 0.3);
    });
  }
  // Called from a click, so the browser allows sound and the permission prompt.
  function primeAlerts() {
    audioCtx();
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission().catch(() => {}); } catch { /* old Safari */ }
    }
  }
  let lastChime = 0;
  function alertUser(title, body) {
    if (!document.hidden && document.hasFocus()) return;
    unread++;
    updateTitle();
    const now = Date.now();
    if (now - lastChime > 1500) { lastChime = now; chime(); } // a busy group shouldn't machine-gun sounds
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body, tag: `itext-${room}`, renotify: true, icon: 'icon.svg', silent: true });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* mobile browsers need a service worker for notifications */ }
    }
  }

  // ---------------------------------------------------------------- stay alive in background tabs
  // - A held Web Lock stops Chrome/Edge from freezing or discarding the tab.
  // - Worker timers aren't throttled like page timers, so keep-alives and dead-peer
  //   checks keep running while the tab is hidden or the window is minimised.
  let releaseLock = null, hbWorker = null;
  function keepAlive(on) {
    if (on) {
      if (!releaseLock && navigator.locks?.request) {
        navigator.locks.request(`itext-alive-${uid()}`, () => new Promise((res) => { releaseLock = res; })).catch(() => {});
      }
      if (!hbWorker) {
        try {
          const src = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 10000);'], { type: 'text/javascript' }));
          hbWorker = new Worker(src);
          hbWorker.onmessage = heartbeat;
        } catch { hbWorker = null; }
      }
    } else {
      if (releaseLock) { releaseLock(); releaseLock = null; }
      if (hbWorker) { hbWorker.terminate(); hbWorker = null; }
    }
  }
  function heartbeat() {
    const now = Date.now();
    if (role === 'host') {
      for (const [id, m] of [...members]) {
        if (now - m.lastSeen > PEER_TIMEOUT) dropMember(id, m.conn);
        else if (m.conn.open) { try { m.conn.send({ t: 'ping' }); } catch { /* */ } }
      }
    } else if (role === 'guest' && conn) {
      if (now - hostLastSeen > PEER_TIMEOUT) { hostLost(); return; }
      if (conn.open) { try { conn.send({ t: 'ping' }); } catch { /* */ } }
    }
    if (recovery && !recovery.busy && !recovery.timer) recoveryStep();
    const p = peer;
    if (p && !p.destroyed) {
      if (p.disconnected) { try { p.reconnect(); } catch { /* next tick */ } }
      else { try { p.socket?.send({ type: 'HEARTBEAT' }); } catch { /* */ } }
    }
  }
  addEventListener('online', heartbeat);
  addEventListener('offline', () => toast('You are offline. The chat will resume when you reconnect.'));
  addEventListener('pagehide', () => {
    if (role === 'host') members.forEach((m) => { try { m.conn.send({ t: 'bye' }); } catch { /* */ } });
    else if (conn && conn.open) { try { conn.send({ t: 'bye' }); } catch { /* */ } }
  });

  // ---------------------------------------------------------------- boot
  if (typeof Peer === 'undefined') {
    homeStatus('Could not load the connection library. Check your internet and reload.', 'err');
    setBusy(ui.create); ui.create.classList.remove('loading');
  }
  setComposer(false);
  const invited = cleanRoom(new URLSearchParams(location.search).get('room'));
  if (invited) {
    ui.roomInput.value = invited;
    homeStatus(`You're invited to #${invited}. Enter your name and tap Join room.`, 'ok');
    ui.join.classList.add('pulse');
    const target = cleanName(ui.nameInput.value) ? ui.join : ui.nameInput;
    target.focus({ preventScroll: true });
    requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
  }
})();
