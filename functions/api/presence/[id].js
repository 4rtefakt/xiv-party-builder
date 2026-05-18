// GET /api/presence/:id  (WebSocket upgrade)
// Le client front ouvre un WS sur cette URL pour recevoir les notifications
// temps-réel "room changed". On forward l'upgrade vers le Durable Object
// RoomBroadcast (Worker séparé `xiv-party-presence`, cf do-worker/).
//
// Pas d'auth requise : cohérent avec le modèle existant où l'ID de la room
// EST le secret. Tout client avec un ID valide peut souscrire aux events
// (lecture seule, broadcast anonyme — aucune info sur les autres clients).

const VALID_ID = /^[A-Za-z0-9]{4,12}$/;

export async function onRequestGet({ params, request, env }) {
  if (!env.ROOM_BROADCAST) {
    return new Response('ROOM_BROADCAST binding missing (worker pas déployé ?)', { status: 500 });
  }
  const id = params.id;
  if (!VALID_ID.test(id)) return new Response('Invalid id', { status: 400 });

  const upgrade = request.headers.get('Upgrade');
  if (upgrade !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // 1 DO instance par room (clé = room ID). idFromName est déterministe
  // donc tous les clients d'une même room atterrissent sur la même instance.
  const stub = env.ROOM_BROADCAST.get(env.ROOM_BROADCAST.idFromName(id));
  // Forward la requête d'upgrade au DO. L'URL ciblée est /ws (handled par
  // le DO.fetch). On clone juste headers + method, le DO gère le 101.
  return stub.fetch('https://do-internal/ws', {
    headers: request.headers,
    method: 'GET'
  });
}
