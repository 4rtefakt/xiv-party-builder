// Client WebSocket pour les notifications "room changed" en temps réel.
// Le DO `RoomBroadcast` (cf do-worker/) broadcaste un { type:'changed',
// hash, savedAt } à chaque save d'une room aux clients connectés via
// /api/presence/:id. Ce module abstrait l'ouverture, reconnect, et expose
// un callback minimal.
//
// Pas de DOM ici (pour pouvoir tester avec un WebSocket mock injecté).
// L'intégration UI vit dans index.html.
//
// Privacy : on n'envoie aucun userId / nom dans le WS. Le serveur ne tracke
// pas qui est connecté. Les events reçus ne contiennent jamais d'info sur
// les autres clients.

const DEFAULT_OPTIONS = {
  // Backoff exponentiel borné. 1s, 2s, 4s, ..., max 30s entre tentatives.
  initialReconnectMs: 1000,
  maxReconnectMs: 30_000,
  // Ping client → serveur toutes les 25s pour éviter que les proxies / NAT
  // ferment la connection idle (et permet de détecter une coupure muette).
  heartbeatMs: 25_000,
  // Si on n'a pas reçu de pong (ou tout message serveur) depuis ce délai,
  // on considère la connexion morte et on déclenche un reconnect.
  pongTimeoutMs: 60_000
};

// Construit l'URL WebSocket à partir de l'URL HTTP courante (gère le swap
// http→ws et https→wss). Pure → testable sans DOM.
export function buildPresenceUrl(origin, roomId) {
  const u = new URL(origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/presence/' + encodeURIComponent(roomId);
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function createLiveSync({
  // WebSocketImpl : permet d'injecter un mock pour les tests. Par défaut le
  // WebSocket global (browser ou Node ≥22).
  WebSocketImpl = (typeof WebSocket !== 'undefined' ? WebSocket : null),
  // origin : où chercher le serveur (URL avec proto + host). En browser =
  // window.location.origin. En test, on injecte une URL.
  origin,
  options = {}
} = {}) {
  if (!WebSocketImpl) throw new Error('No WebSocket implementation available');
  const opts = { ...DEFAULT_OPTIONS, ...options };

  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let pongTimer = null;
  let reconnectDelay = opts.initialReconnectMs;
  let intentionallyClosed = false;
  let currentRoomId = null;
  let onChangeCallback = null;
  let onStatusCallback = null;

  function setStatus(status) {
    if (onStatusCallback) {
      try { onStatusCallback(status); } catch { /* ignore */ }
    }
  }

  function clearTimers() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  }

  function scheduleReconnect() {
    if (intentionallyClosed || !currentRoomId) return;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(() => connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, opts.maxReconnectMs);
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      try {
        ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      } catch { /* connexion morte, on laisse close gérer */ }
      // Si pas de message reçu (pong ou autre) dans pongTimeoutMs, on force
      // un close → reconnect (la connexion est probablement zombie).
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        try { if (ws) ws.close(4000, 'pong timeout'); } catch { /* ignore */ }
      }, opts.pongTimeoutMs);
    }, opts.heartbeatMs);
  }

  function connect() {
    if (!currentRoomId) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const url = buildPresenceUrl(origin, currentRoomId);
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    setStatus('connecting');

    ws.addEventListener('open', () => {
      reconnectDelay = opts.initialReconnectMs;
      setStatus('connected');
      startHeartbeat();
    });

    ws.addEventListener('message', (event) => {
      // Tout message reçu = signe de vie → reset le pong timeout
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      let msg;
      try { msg = typeof event.data === 'string' ? JSON.parse(event.data) : null; }
      catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'changed') {
        if (onChangeCallback) {
          try { onChangeCallback(msg); } catch { /* ignore caller errors */ }
        }
      }
      // ping/pong sont gérés au niveau "reçu = vivant" ci-dessus, pas besoin
      // de répondre (le serveur attend juste qu'on envoie nos propres pings).
    });

    ws.addEventListener('close', () => {
      clearTimers();
      ws = null;
      setStatus('disconnected');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // close suivra ; on laisse le handler close gérer le reconnect
    });
  }

  return {
    subscribe(roomId, onChange, onStatus) {
      if (typeof roomId !== 'string' || roomId.length === 0) return;
      // Si on est déjà sur cette room, on garde la connexion existante.
      if (currentRoomId === roomId && ws && ws.readyState === 1) {
        onChangeCallback = onChange || null;
        onStatusCallback = onStatus || null;
        if (onStatusCallback) setStatus('connected');
        return;
      }
      this.unsubscribe();
      intentionallyClosed = false;
      currentRoomId = roomId;
      onChangeCallback = onChange || null;
      onStatusCallback = onStatus || null;
      reconnectDelay = opts.initialReconnectMs;
      connect();
    },
    unsubscribe() {
      intentionallyClosed = true;
      currentRoomId = null;
      onChangeCallback = null;
      const prevStatus = onStatusCallback;
      onStatusCallback = null;
      clearTimers();
      if (ws) {
        try { ws.close(1000, 'unsubscribe'); } catch { /* ignore */ }
        ws = null;
      }
      if (prevStatus) {
        try { prevStatus('disconnected'); } catch { /* ignore */ }
      }
    },
    // Exposés pour debugging / tests
    getState() {
      return {
        roomId: currentRoomId,
        connected: !!(ws && ws.readyState === 1),
        readyState: ws ? ws.readyState : null
      };
    }
  };
}
