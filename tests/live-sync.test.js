// Tests pour lib/live-sync.js — WebSocket client avec reconnect.
// Mock minimal de WebSocket (event listeners + readyState) pour driver
// les scénarios sans serveur réel.
//
// ⚠ Tous les tests qui appellent _open() doivent absolument appeler
// sync.unsubscribe() pour clear le heartbeat setInterval, sinon Node ne
// peut pas exit (le test runner reste bloqué sur les open handles).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSync, buildPresenceUrl } from '../lib/live-sync.js';

// ---------- buildPresenceUrl ----------

test('buildPresenceUrl : https → wss + path /api/presence/:id', () => {
  assert.equal(
    buildPresenceUrl('https://example.com', 'abc123'),
    'wss://example.com/api/presence/abc123'
  );
});

test('buildPresenceUrl : http → ws (dev local)', () => {
  assert.equal(
    buildPresenceUrl('http://localhost:8000', 'r4'),
    'ws://localhost:8000/api/presence/r4'
  );
});

test('buildPresenceUrl : encode l\'ID en URI', () => {
  assert.equal(
    buildPresenceUrl('https://x.dev', 'a/b'),
    'wss://x.dev/api/presence/a%2Fb'
  );
});

test('buildPresenceUrl : strip query + hash de l\'origin', () => {
  assert.equal(
    buildPresenceUrl('https://x.dev/?p=foo#bar', 'rid'),
    'wss://x.dev/api/presence/rid'
  );
});

// ---------- Mock WebSocket ----------

class MockWS {
  constructor(url) {
    MockWS.lastInstance = this;
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.listeners = { open: [], message: [], close: [], error: [] };
    this.sent = [];
    this.closeArgs = null;
  }
  addEventListener(type, fn) {
    if (this.listeners[type]) this.listeners[type].push(fn);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close(code, reason) {
    this.closeArgs = [code, reason];
    this.readyState = 3;
    this._emit('close', { code, reason, wasClean: true });
  }
  _emit(type, event) {
    for (const fn of (this.listeners[type] || [])) fn(event);
  }
  _open() { this.readyState = 1; this._emit('open', {}); }
  _msg(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
  _serverClose() { this.readyState = 3; this._emit('close', { code: 1006, wasClean: false }); }
}

// Helper : crée un sync avec heartbeat très court pour éviter qu'un test
// oublié leak un interval > 25s. unsubscribe() reste obligatoire en fin
// de test mais c'est une 2e ceinture.
function makeSync(opts = {}) {
  return createLiveSync({
    WebSocketImpl: MockWS,
    origin: 'https://x.dev',
    options: { heartbeatMs: 100, pongTimeoutMs: 200, initialReconnectMs: 10, maxReconnectMs: 25, ...opts }
  });
}

// ---------- subscribe / unsubscribe ----------

test('subscribe : connecte au bon URL et appelle onStatus("connecting" → "connected")', () => {
  const statuses = [];
  const sync = makeSync();
  try {
    sync.subscribe('room1', () => {}, (s) => statuses.push(s));
    assert.equal(MockWS.lastInstance.url, 'wss://x.dev/api/presence/room1');
    assert.deepEqual(statuses, ['connecting']);
    MockWS.lastInstance._open();
    assert.deepEqual(statuses, ['connecting', 'connected']);
  } finally { sync.unsubscribe(); }
});

test('subscribe : message {type:changed} appelle onChange avec le payload', () => {
  const changes = [];
  const sync = makeSync();
  try {
    sync.subscribe('r', (m) => changes.push(m));
    MockWS.lastInstance._open();
    MockWS.lastInstance._msg({ type: 'changed', hash: 'abc', savedAt: 42 });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].hash, 'abc');
    assert.equal(changes[0].savedAt, 42);
  } finally { sync.unsubscribe(); }
});

test('subscribe : messages non-"changed" ignorés (pas d\'appel à onChange)', () => {
  const changes = [];
  const sync = makeSync();
  try {
    sync.subscribe('r', (m) => changes.push(m));
    MockWS.lastInstance._open();
    MockWS.lastInstance._msg({ type: 'pong', t: 1 });
    MockWS.lastInstance._msg({ type: 'whatever' });
    assert.equal(changes.length, 0);
  } finally { sync.unsubscribe(); }
});

test('subscribe : message non-JSON ignoré silencieusement', () => {
  const changes = [];
  const sync = makeSync();
  try {
    sync.subscribe('r', (m) => changes.push(m));
    MockWS.lastInstance._open();
    MockWS.lastInstance._emit('message', { data: 'not json {{' });
    assert.equal(changes.length, 0);
  } finally { sync.unsubscribe(); }
});

test('unsubscribe : ferme le socket avec code 1000 et émet "disconnected"', () => {
  const statuses = [];
  const sync = makeSync();
  sync.subscribe('r', () => {}, (s) => statuses.push(s));
  MockWS.lastInstance._open();
  const ws = MockWS.lastInstance;
  sync.unsubscribe();
  assert.equal(ws.closeArgs[0], 1000);
  assert.ok(statuses.includes('disconnected'));
});

test('unsubscribe : pas de reconnect après close intentional', async () => {
  const sync = makeSync();
  try {
    sync.subscribe('r', () => {});
    MockWS.lastInstance._open();
    const firstWs = MockWS.lastInstance;
    sync.unsubscribe();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(MockWS.lastInstance, firstWs, 'pas de reconnect après unsubscribe');
  } finally { sync.unsubscribe(); }
});

test('reconnect : close non-intentional → nouvelle instance après delay', async () => {
  const sync = makeSync();
  try {
    sync.subscribe('r', () => {});
    const firstWs = MockWS.lastInstance;
    firstWs._open();
    firstWs._serverClose();
    assert.equal(MockWS.lastInstance, firstWs);
    await new Promise(r => setTimeout(r, 40));
    assert.notEqual(MockWS.lastInstance, firstWs);
    assert.equal(MockWS.lastInstance.url, 'wss://x.dev/api/presence/r');
  } finally { sync.unsubscribe(); }
});

test('re-subscribe sur même room avec socket OPEN : pas de nouveau socket', () => {
  const sync = makeSync();
  try {
    sync.subscribe('r', () => {});
    const firstWs = MockWS.lastInstance;
    firstWs._open();
    sync.subscribe('r', () => {});
    assert.equal(MockWS.lastInstance, firstWs, 'même instance réutilisée');
  } finally { sync.unsubscribe(); }
});

test('re-subscribe sur room différente : ferme l\'ancien socket + ouvre le nouveau', () => {
  const sync = makeSync();
  try {
    sync.subscribe('roomA', () => {});
    const wsA = MockWS.lastInstance;
    wsA._open();
    sync.subscribe('roomB', () => {});
    assert.equal(wsA.closeArgs[0], 1000, 'ancien socket fermé proprement');
    assert.notEqual(MockWS.lastInstance, wsA);
    assert.match(MockWS.lastInstance.url, /\/roomB$/);
  } finally { sync.unsubscribe(); }
});

test('re-subscribe room différente : un close ASYNCHRONE de l\'ancien socket est ignoré (pas de doublon)', async () => {
  // Dans un vrai browser, l'event close arrive de façon asynchrone après
  // ws.close(). Régression : le handler close ne vérifiait pas qu'il
  // appartenait au socket COURANT — le close périmé de l'ancienne room
  // nullait le nouveau socket et déclenchait un reconnect en doublon
  // (deux WS vivants → onChange appelé deux fois par save).
  const changes = [];
  const sync = makeSync();
  try {
    sync.subscribe('roomA', (m) => changes.push(m));
    const wsA = MockWS.lastInstance;
    wsA._open();
    // Simule l'async browser : on retient l'event close de wsA pour le
    // rejouer APRÈS que la connexion roomB est établie.
    const realEmit = wsA._emit.bind(wsA);
    wsA._emit = () => {};
    sync.subscribe('roomB', (m) => changes.push(m));
    const wsB = MockWS.lastInstance;
    assert.notEqual(wsB, wsA);
    wsB._open();
    // Le close de wsA arrive maintenant, en retard
    wsA._emit = realEmit;
    realEmit('close', { code: 1000, wasClean: true });
    await new Promise(r => setTimeout(r, 40)); // laisse un éventuel reconnect (bug) partir
    assert.equal(MockWS.lastInstance, wsB, 'pas de socket doublon créé par le close périmé');
    assert.equal(sync.getState().connected, true, 'la connexion roomB reste vivante');
    // Un message arrivant sur l'ancien socket orphelin ne doit PAS remonter
    realEmit('message', { data: JSON.stringify({ type: 'changed', hash: 'stale' }) });
    wsB._msg({ type: 'changed', hash: 'fresh' });
    assert.deepEqual(changes.map(c => c.hash), ['fresh']);
  } finally { sync.unsubscribe(); }
});

test('getState : reflète l\'état du socket', () => {
  const sync = makeSync();
  try {
    assert.deepEqual(sync.getState(), { roomId: null, connected: false, readyState: null });
    sync.subscribe('r', () => {});
    assert.equal(sync.getState().roomId, 'r');
    assert.equal(sync.getState().connected, false);
    MockWS.lastInstance._open();
    assert.equal(sync.getState().connected, true);
  } finally { sync.unsubscribe(); }
  assert.equal(sync.getState().roomId, null);
});
