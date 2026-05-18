// xiv-party-presence : Worker dédié hébergeant la classe Durable Object
// RoomBroadcast. Le projet Pages (functions/) le référence via un binding
// pour pouvoir notifier les clients connectés à une room en temps réel.
//
// Privacy : ce DO ne tracke PAS qui est connecté. Il maintient juste un Set
// de WebSockets ouverts par room (pour pouvoir broadcast), sans identité
// associée à chaque socket. Aucun message contenant des infos sur les autres
// clients n'est envoyé — uniquement des notifications "data changed" anonymes.
//
// Pattern : Hibernatable WebSockets. Le DO peut s'endormir entre les events
// (économise la facturation duration), et les events arrivent via les
// méthodes webSocketMessage()/webSocketClose() sur la classe. Cf
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/

const VALID_ROOM_ID = /^[A-Za-z0-9]{4,12}$/;

// Frequency at which we ping idle clients (browsers tend to close idle WS
// after ~60s on mobile or in background tabs). Heartbeat plus court que les
// timeouts navigateur typiques.
const HEARTBEAT_INTERVAL_MS = 25_000;

// Si un client ne pong pas après N ms, on le considère mort et on le ferme.
const PONG_TIMEOUT_MS = 60_000;

export class RoomBroadcast {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // Endpoint interne (HTTP, pas WS) appelé par les autres workers ou Pages
  // Functions pour broadcaster un event à tous les sockets de cette room.
  // Body attendu : JSON { hash: string, savedAt: number } — pas de données
  // sensibles, juste un signal "data changed", le client refetch via /api/load/.
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // acceptWebSocket() = mode hibernatable : le DO peut s'endormir entre
      // les events, et webSocketMessage/Close sont appelés à la place des
      // addEventListener. Cf hibernation API.
      this.state.acceptWebSocket(server);
      // Schedule un alarm périodique pour heartbeat (si pas déjà fait)
      const existingAlarm = await this.state.storage.getAlarm();
      if (existingAlarm === null) {
        this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return new Response('bad json', { status: 400 }); }
      const message = JSON.stringify({
        type: 'changed',
        hash: body.hash || null,
        savedAt: body.savedAt || Date.now()
      });
      const sockets = this.state.getWebSockets();
      let sent = 0;
      for (const ws of sockets) {
        try {
          ws.send(message);
          sent++;
        } catch {
          // Socket dans un état invalide : on l'ignore (cleanup via webSocketClose)
        }
      }
      return Response.json({ ok: true, sent });
    }

    return new Response('not found', { status: 404 });
  }

  // Hibernation API : appelé quand un client envoie un message. On accepte
  // un seul message utile : "ping" → on répond "pong". Tout autre message
  // est ignoré (le client n'a pas vocation à écrire vers le serveur via WS).
  async webSocketMessage(ws, message) {
    let parsed;
    try { parsed = typeof message === 'string' ? JSON.parse(message) : null; }
    catch { return; }
    if (parsed && parsed.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); }
      catch { /* ignore */ }
    }
    // Tout autre message est silencieusement ignoré (politique fail-safe).
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Pas de state par socket à nettoyer (volontaire : pas de présence
    // individuelle). getWebSockets() retire automatiquement ce ws.
  }

  async webSocketError(ws, error) {
    // Pareil que close : pas de cleanup à faire.
  }

  // Heartbeat : envoie un ping à tous les sockets connectés. Si plus aucun
  // socket, on arrête l'alarm (le DO peut hiberner complètement).
  async alarm() {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      return; // pas de re-schedule → l'alarm s'arrête
    }
    const pingMsg = JSON.stringify({ type: 'ping', t: Date.now() });
    for (const ws of sockets) {
      try {
        ws.send(pingMsg);
      } catch {
        // Socket mort : try-close pour le retirer définitivement
        try { ws.close(1011, 'heartbeat send failed'); } catch { /* ignore */ }
      }
    }
    // Re-schedule
    this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }
}

// Le worker lui-même n'expose pas de routes publiques — seulement le DO.
// Toute requête tombée ici (pas via le binding DO depuis Pages) renvoie 404.
export default {
  async fetch(request, env) {
    return new Response('xiv-party-presence : access via DO binding from Pages', { status: 404 });
  }
};
