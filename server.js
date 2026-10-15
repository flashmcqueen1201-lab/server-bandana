'use strict';

/* =============================================================================
   BANDANA FIGHTERS REMASTER — SERVEUR EN LIGNE
   Node.js + WebSocket "ws"

   PATCH PROTOCOLE 2 :
   - Wallace
   - PV max par personnage
   - pistol / shotgun / smg / railgun
   - projectiles serveur autoritaires
   - visée ax / ay
   - visée haute
   - phit
   - proto: 2 dans les messages réseau
   - projectiles synchronisés dans les snapshots
   ============================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let WebSocketServer;

try {
  ({ WebSocketServer } = require('ws'));
} catch (e) {
  console.error(
    '\n[!] Le module "ws" est introuvable. Lance d\'abord : npm install\n'
  );
  process.exit(1);
}

const PORT =
  parseInt(process.env.PORT, 10) || 3000;

const BOSS_CHANCE =
  process.env.BOSS_CHANCE !== undefined
    ? parseFloat(process.env.BOSS_CHANCE)
    : 0.05;

const PROTO = 2;

/* -----------------------------------------------------------------------------
   CONSTANTES
   ----------------------------------------------------------------------------- */

const GAME_W = 400;
const GAME_H = 700;

const GROUND_Y = GAME_H - 70;

const GRAVITY = 1750;
const BASE_SPEED = 150;
const BASE_JUMP_V = -640;

const PLAYER_MAX_HP = 100;

const ENEMY_DEATH_VISUAL_MS = 760;
const BOSS_DEATH_VISUAL_MS = 760;

/* -----------------------------------------------------------------------------
   PERSONNAGES
   ----------------------------------------------------------------------------- */

const CHARACTERS = {
  ryder: {
    id: 'ryder',
    speedMult: 1.25,
    jumpMult: 1.0,
    dmgMult: 1.0,
    hpMult: 1.0
  },

  luma: {
    id: 'luma',
    speedMult: 1.0,
    jumpMult: 1.3,
    dmgMult: 1.0,
    hpMult: 1.0
  },

  jacob: {
    id: 'jacob',
    speedMult: 1.0,
    jumpMult: 1.0,
    dmgMult: 1.25,
    hpMult: 1.0
  },

  wallace: {
    id: 'wallace',
    speedMult: 0.9,
    jumpMult: 0.9,
    dmgMult: 1.0,
    hpMult: 1.3
  }
};

/* -----------------------------------------------------------------------------
   ARMES
   -----------------------------------------------------------------------------

   IMPORTANT :
   Les valeurs doivent rester identiques à celles du client.

   fists / gauntlet = mêlée
   pistol / shotgun / smg / railgun = distance
   ----------------------------------------------------------------------------- */

const WEAPONS = {
  fists: {
    id: 'fists',
    damage: 7,
    cooldown: 420,
    range: 44,
    special: null,
    ranged: false
  },

  gauntlet: {
    id: 'gauntlet',
    damage: 15,
    cooldown: 480,
    range: 52,
    special: 'knockback',
    ranged: false
  },

  pistol: {
    id: 'pistol',
    damage: 10,
    cooldown: 300,
    range: 700,
    speed: 700,
    special: null,
    ranged: true
  },

  shotgun: {
    id: 'shotgun',
    damage: 8,
    cooldown: 800,
    range: 500,
    speed: 650,
    pellets: 6,
    spread: 0.16,
    special: null,
    ranged: true
  },

  smg: {
    id: 'smg',
    damage: 5,
    cooldown: 110,
    range: 650,
    speed: 850,
    special: null,
    ranged: true
  },

  railgun: {
    id: 'railgun',
    damage: 30,
    cooldown: 1200,
    range: 1000,
    speed: 1200,
    pierce: true,
    special: null,
    ranged: true
  }
};

/* -----------------------------------------------------------------------------
   ENNEMIS
   ----------------------------------------------------------------------------- */

const ENEMY_TYPES = {
  grunt: {
    type: 'grunt',
    hpBase: 28,
    speed: 85,
    damage: 7,
    atkRange: 38,
    atkCd: 1000,
    points: 10,
    width: 34,
    height: 60
  },

  rusher: {
    type: 'rusher',
    hpBase: 18,
    speed: 150,
    damage: 6,
    atkRange: 34,
    atkCd: 750,
    points: 14,
    width: 32,
    height: 58
  },

  thrower: {
    type: 'thrower',
    hpBase: 16,
    speed: 55,
    damage: 5,
    atkRange: 230,
    atkCd: 1700,
    points: 18,
    width: 32,
    height: 58,
    ranged: true
  }
};

/* -----------------------------------------------------------------------------
   MULTIJOUEUR
   ----------------------------------------------------------------------------- */

const COOP_MAX_ENEMIES = 6;
const COOP_SPAWN_START = 2200;
const COOP_SPAWN_MIN = 900;

const COOP_BOSS_HP_MULT = 1.6;

const DUEL_DMG_MULT = 1.5;
const DUEL_INVULN_MS = 400;
const COOP_INVULN_MS = 550;

const HIT_FORGIVE = 12;

const COUNTDOWN_MS = 3000;

const SIM_HZ = 60;
const SNAP_HZ = 20;

const RECONNECT_GRACE_MS = 15000;

const MAX_ROOMS = 300;
const MAX_CLIENTS = 800;

/* -----------------------------------------------------------------------------
   OUTILS
   ----------------------------------------------------------------------------- */

const nowMs = () =>
  Number(process.hrtime.bigint() / 1000000n);

const clamp = (v, a, b) =>
  Math.max(a, Math.min(b, v));

const r1 = v =>
  Math.round(v * 10) / 10;

function rectsIntersect(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/* -----------------------------------------------------------------------------
   CODES DE ROOM
   ----------------------------------------------------------------------------- */

const CODE_ALPHABET =
  'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  for (let n = 0; n < 50; n++) {
    let c = '';

    for (let i = 0; i < 6; i++) {
      c += CODE_ALPHABET[
        crypto.randomInt(CODE_ALPHABET.length)
      ];
    }

    if (!rooms.has(c)) {
      return c;
    }
  }

  return null;
}

function normCode(v) {
  return String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const CODE_RE =
  /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/* -----------------------------------------------------------------------------
   SERVEUR HTTP
   ----------------------------------------------------------------------------- */

const PUBLIC_DIR =
  path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',

  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',

  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',

  '.woff2': 'font/woff2'
};

const server =
  http.createServer((req, res) => {
    let urlPath;

    try {
      urlPath = decodeURIComponent(
        (req.url || '/').split('?')[0]
      );
    } catch (e) {
      urlPath = '/';
    }

    if (urlPath === '/health') {
      res.writeHead(200, {
        'Content-Type':
          'application/json'
      });

      res.end(
        JSON.stringify({
          ok: true,
          proto: PROTO,
          rooms: rooms.size,
          clients: wss
            ? wss.clients.size
            : 0
        })
      );

      return;
    }

    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    const filePath =
      path.normalize(
        path.join(PUBLIC_DIR, urlPath)
      );

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(
      filePath,
      (err, data) => {
        if (err) {
          res.writeHead(404, {
            'Content-Type':
              'text/plain; charset=utf-8'
          });

          res.end('Introuvable');
          return;
        }

        const ext =
          path.extname(filePath)
            .toLowerCase();

        res.writeHead(200, {
          'Content-Type':
            MIME[ext] ||
            'application/octet-stream',

          'Cache-Control':
            ext === '.html'
              ? 'no-cache'
              : 'public, max-age=3600'
        });

        res.end(data);
      }
    );
  });

const wss =
  new WebSocketServer({
    server,
    maxPayload: 2048,
    perMessageDeflate: false
  });

const rooms = new Map();

/* -----------------------------------------------------------------------------
   ENVOI
   ----------------------------------------------------------------------------- */

function send(ws, obj) {
  if (
    ws &&
    ws.readyState === 1
  ) {
    try {
      ws.send(
        JSON.stringify(obj)
      );
    } catch (e) {
      /* socket en fermeture */
    }
  }
}

function sendSeat(seat, obj) {
  if (seat) {
    send(seat.ws, obj);
  }
}

function broadcast(room, obj) {
  const s =
    JSON.stringify(obj);

  room.seats.forEach(seat => {
    if (
      seat &&
      seat.ws &&
      seat.ws.readyState === 1
    ) {
      try {
        seat.ws.send(s);
      } catch (e) {
        /* ignore */
      }
    }
  });
}

function roomInfo(room) {
  return {
    t: 'room',
    proto: PROTO,

    code: room.code,
    mode: room.mode,
    status: room.status,

    host: 0,

    seats:
      room.seats.map(s =>
        s
          ? {
              char: s.char,
              ready: s.ready,
              conn: !!s.ws,
              weapon: s.weapon
            }
          : null
      )
  };
}

function sendErr(ws, code, msg) {
  send(ws, {
    t: 'err',
    proto: PROTO,
    code,
    msg
  });
}

/* -----------------------------------------------------------------------------
   ROOMS
   ----------------------------------------------------------------------------- */

function newSeat(ws, slot) {
  return {
    slot,
    ws,

    token:
      crypto.randomBytes(12)
        .toString('hex'),

    char: 'ryder',
    weapon: 'pistol',

    ready: false,
    timer: null
  };
}

function attach(ws, room, seat) {
  ws.room = room;
  ws.seat = seat;

  seat.ws = ws;
}

function detach(seat) {
  if (
    seat &&
    seat.ws
  ) {
    seat.ws.room = null;
    seat.ws.seat = null;
    seat.ws = null;
  }
}

function destroyRoom(room) {
  room.seats.forEach(s => {
    if (s && s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  });

  rooms.delete(room.code);
}

function touch(room) {
  room.lastActivity =
    Date.now();
}

function createRoom(ws) {
  if (
    rooms.size >= MAX_ROOMS
  ) {
    sendErr(
      ws,
      'BUSY',
      'Serveur plein, réessaie dans un instant.'
    );

    return;
  }

  const code =
    makeCode();

  if (!code) {
    sendErr(
      ws,
      'BUSY',
      'Impossible de créer une partie.'
    );

    return;
  }

  const room = {
    code,

    mode: 'coop',
    status: 'lobby',

    seats: [null, null],

    sim: null,

    paused: false,

    rematch: [
      false,
      false
    ],

    snapAcc: 0,

    lastActivity:
      Date.now(),

    created:
      Date.now()
  };

  const seat =
    newSeat(ws, 0);

  room.seats[0] =
    seat;

  rooms.set(
    code,
    room
  );

  attach(
    ws,
    room,
    seat
  );

  send(ws, {
    t: 'created',
    proto: PROTO,

    code,
    slot: 0,
    token: seat.token
  });

  broadcast(
    room,
    roomInfo(room)
  );
}

function joinRoom(
  ws,
  rawCode
) {
  const code =
    normCode(rawCode);

  if (!CODE_RE.test(code)) {
    sendErr(
      ws,
      'INVALID',
      'Code invalide : il faut 6 caractères (lettres et chiffres).'
    );

    return;
  }

  const room =
    rooms.get(code);

  if (!room) {
    sendErr(
      ws,
      'NOT_FOUND',
      'Aucune partie avec ce code.'
    );

    return;
  }

  if (room.seats[1]) {
    sendErr(
      ws,
      'FULL',
      'Cette partie est déjà complète.'
    );

    return;
  }

  if (
    room.status !==
    'lobby'
  ) {
    sendErr(
      ws,
      'STARTED',
      'Cette partie a déjà commencé.'
    );

    return;
  }

  const seat =
    newSeat(ws, 1);

  room.seats[1] =
    seat;

  attach(
    ws,
    room,
    seat
  );

  touch(room);

  send(ws, {
    t: 'joined',
    proto: PROTO,

    code,
    slot: 1,
    token: seat.token
  });

  room.seats[0].ready =
    false;

  broadcast(
    room,
    roomInfo(room)
  );
}

function resumeRoom(
  ws,
  rawCode,
  token
) {
  const code =
    normCode(rawCode);

  const room =
    rooms.get(code);

  if (!room) {
    sendErr(
      ws,
      'NOT_FOUND',
      'La partie n\'existe plus.'
    );

    return;
  }

  const seat =
    room.seats.find(
      s =>
        s &&
        s.token ===
          String(token || '')
    );

  if (!seat) {
    sendErr(
      ws,
      'NOT_FOUND',
      'Session expirée.'
    );

    return;
  }

  if (
    seat.ws &&
    seat.ws !== ws
  ) {
    const old =
      seat.ws;

    detach(seat);

    try {
      old.terminate();
    } catch (e) {}
  }

  if (seat.timer) {
    clearTimeout(
      seat.timer
    );

    seat.timer = null;
  }

  attach(
    ws,
    room,
    seat
  );

  touch(room);

  room.paused =
    room.seats.some(
      s =>
        s &&
        !s.ws
    );

  send(ws, {
    t: 'resumed',
    proto: PROTO,

    code,
    slot: seat.slot,
    token: seat.token,
    status: room.status
  });

  broadcast(
    room,
    roomInfo(room)
  );

  if (
    room.status ===
      'playing' &&
    room.sim
  ) {
    send(
      ws,
      startMessage(
        room,
        seat.slot,
        true
      )
    );
  }

  if (
    room.status ===
      'over' &&
    room.lastEnd
  ) {
    send(
      ws,
      room.lastEnd
    );
  }

  const other =
    room.seats[
      1 - seat.slot
    ];

  sendSeat(
    other,
    {
      t: 'peer',
      proto: PROTO,
      s: 'back',
      slot: seat.slot
    }
  );
}

function leaveRoom(
  ws,
  why
) {
  const room = ws.room;
  const seat = ws.seat;

  if (!room || !seat) {
    return;
  }

  removeSeat(
    room,
    seat.slot,
    why || 'left'
  );
}

/* -----------------------------------------------------------------------------
   RETRAIT JOUEUR
   ----------------------------------------------------------------------------- */

function removeSeat(
  room,
  slot,
  why
) {
  const seat =
    room.seats[slot];

  if (!seat) {
    return;
  }

  if (seat.timer) {
    clearTimeout(
      seat.timer
    );

    seat.timer = null;
  }

  detach(seat);

  room.seats[slot] =
    null;

  const other =
    room.seats[
      1 - slot
    ];

  if (!other) {
    destroyRoom(room);
    return;
  }

  touch(room);

  if (
    room.status ===
    'lobby'
  ) {
    if (slot === 0) {
      sendSeat(
        other,
        {
          t: 'closed',
          proto: PROTO,
          why: 'host_left'
        }
      );

      detach(other);

      destroyRoom(room);
    } else {
      room.seats[0]
        .ready = false;

      sendSeat(
        other,
        {
          t: 'peer',
          proto: PROTO,
          s: 'left',
          slot,
          why
        }
      );

      broadcast(
        room,
        roomInfo(room)
      );
    }

    return;
  }

  if (
    room.status ===
      'playing' &&
    room.sim &&
    !room.sim.over
  ) {
    const winner =
      room.sim.mode ===
      'duel'
        ? other.slot
        : -1;

    finishGame(
      room,
      'disconnect',
      winner,
      slot
    );
  }

  room.paused =
    false;

  sendSeat(
    other,
    {
      t: 'peer',
      proto: PROTO,
      s: 'left',
      slot,
      why
    }
  );

  broadcast(
    room,
    roomInfo(room)
  );
}

/* -----------------------------------------------------------------------------
   RECONNEXION
   ----------------------------------------------------------------------------- */

function onSocketClose(ws) {
  const room =
    ws.room;

  const seat =
    ws.seat;

  if (
    !room ||
    !seat ||
    seat.ws !== ws
  ) {
    return;
  }

  seat.ws = null;

  ws.room = null;
  ws.seat = null;

  const other =
    room.seats[
      1 - seat.slot
    ];

  if (
    room.status ===
    'playing'
  ) {
    room.paused =
      true;
  }

  sendSeat(
    other,
    {
      t: 'peer',
      proto: PROTO,
      s: 'lost',
      slot: seat.slot
    }
  );

  broadcast(
    room,
    roomInfo(room)
  );

  if (seat.timer) {
    clearTimeout(
      seat.timer
    );
  }

  seat.timer =
    setTimeout(
      () => {
        seat.timer = null;

        if (
          rooms.get(
            room.code
          ) === room &&
          room.seats[
            seat.slot
          ] === seat &&
          !seat.ws
        ) {
          removeSeat(
            room,
            seat.slot,
            'timeout'
          );
        }
      },
      RECONNECT_GRACE_MS
    );
}

/* -----------------------------------------------------------------------------
   SIMULATION
   ----------------------------------------------------------------------------- */

function makePlayer(
  slot,
  seat,
  mode
) {
  const ch =
    CHARACTERS[
      seat.char
    ] ||
    CHARACTERS.ryder;

  let x;

  if (
    mode ===
    'duel'
  ) {
    x =
      slot === 0
        ? 70
        : GAME_W - 70 - 36;
  } else {
    x =
      slot === 0
        ? GAME_W / 2 -
          18 -
          44
        : GAME_W / 2 -
          18 +
          44;
  }

  const maxHp =
    Math.round(
      PLAYER_MAX_HP *
        ch.hpMult
    );

  return {
    slot,

    char: ch.id,

    weapon:
      WEAPONS[
        seat.weapon
      ]
        ? seat.weapon
        : 'pistol',

    x,

    y:
      GROUND_Y - 64,

    width: 36,
    height: 64,

    vx: 0,
    vy: 0,

    facing:
      mode === 'duel'
        ? slot === 0
          ? 1
          : -1
        : 1,

    onGround: true,

    hp: maxHp,
    maxHp,

    alive: true,
    koAt: null,
    reviveRemaining: 0,

    l: 0,
    r: 0,

    ax:
      mode === 'duel'
        ? slot === 0
          ? 1
          : -1
        : 1,

    ay: 0,

    lastAttack:
      -9999,

    invulnUntil: 0,

    coins: 0
  };
}

function createSim(room) {
  const mode =
    room.mode;

  return {
    mode,

    now: 0,

    cd:
      COUNTDOWN_MS,

    over: false,

    ending: null,

    players:
      room.seats.map(
        (s, i) =>
          makePlayer(
            i,
            s,
            mode
          )
      ),

    enemies: [],

    projectiles: [],

    coins: [],

    boss: null,

    score: 0,
    wave: 1,
    waveSpawned: 0,
    waveTarget: 5,
    waveBreak: 0,

    spawnTimer: 0,

    spawnInterval:
      COOP_SPAWN_START,

    lastTierChecked: 0,

    rolledTiers:
      new Set(),

    nextId: 1,

    events: []
  };
}

const ev = (
  sim,
  o
) => {
  sim.events.push(o);
};

function nearestAlive(
  sim,
  cx
) {
  let best = null;
  let bd = Infinity;

  for (
    const p of sim.players
  ) {
    if (!p.alive) {
      continue;
    }

    const d =
      Math.abs(
        p.x +
          p.width / 2 -
          cx
      );

    if (d < bd) {
      bd = d;
      best = p;
    }
  }

  return best;
}

/* -----------------------------------------------------------------------------
   JOUEUR
   ----------------------------------------------------------------------------- */

function updatePlayer(
  sim,
  p,
  dt
) {
  const ch =
    CHARACTERS[
      p.char
    ];

  if (p.alive) {
    const move =
      (p.r ? 1 : 0) -
      (p.l ? 1 : 0);

    p.vx =
      move *
      BASE_SPEED *
      ch.speedMult;

    p.x +=
      p.vx * dt;

    p.x = clamp(
      p.x,
      6,
      GAME_W -
        6 -
        p.width
    );

    if (move !== 0) {
      p.facing =
        move;
    }
  } else {
    p.vx = 0;
  }

  p.vy +=
    GRAVITY * dt;

  p.y +=
    p.vy * dt;

  if (
    p.y +
      p.height >=
    GROUND_Y
  ) {
    p.y =
      GROUND_Y -
      p.height;

    p.vy = 0;

    p.onGround =
      true;
  } else {
    p.onGround =
      false;
  }
}

function damagePlayer(
  sim,
  p,
  dmg,
  sourceX,
  kb
) {
  if (
    !p.alive ||
    sim.over ||
    sim.ending
  ) {
    return false;
  }

  if (
    sim.now <
    p.invulnUntil
  ) {
    return false;
  }

  p.hp -= dmg;

  p.invulnUntil =
    sim.now +
    (
      sim.mode ===
      'duel'
        ? DUEL_INVULN_MS
        : COOP_INVULN_MS
    );

  ev(
    sim,
    {
      k: 'hurt',
      s: p.slot,
      d: dmg,
      x: r1(
        p.x +
          p.width / 2
      ),
      y: r1(p.y)
    }
  );

  const kdir =
    (
      p.x +
        p.width / 2
    ) <
    sourceX
      ? -1
      : 1;

  p.x = clamp(
    p.x +
      kdir *
        (kb || 10),
    6,
    GAME_W -
      6 -
      p.width
  );

  if (p.hp <= 0) {
    p.hp = 0;

    p.alive =
      false;
    p.koAt = sim.now;
    p.reviveRemaining = sim.mode !== 'duel' ? 5000 : 0;

    p.l = 0;
    p.r = 0;

    ev(
      sim,
      {
        k: 'ko',
        s: p.slot
      }
    );
  }

  return true;
}

/* -----------------------------------------------------------------------------
   COINS
   ----------------------------------------------------------------------------- */

function spawnCoin(
  sim,
  x,
  y,
  value
) {
  const c = {
    id:
      sim.nextId++,

    x:
      x - 8,

    y:
      y - 14,

    width: 16,
    height: 16,

    value,

    vy: -260
  };

  sim.coins.push(c);

  ev(
    sim,
    {
      k: 'cspawn',
      x: r1(x),
      y: r1(y),
      v: value
    }
  );
}

/* -----------------------------------------------------------------------------
   PROJECTILES ENNEMIS
   ----------------------------------------------------------------------------- */

function spawnProjectile(
  sim,
  en,
  dir
) {
  sim.projectiles.push({
    id:
      sim.nextId++,

    x:
      dir === 1
        ? en.x +
          en.width
        : en.x - 10,

    y:
      en.y +
      en.height *
        0.4,

    width: 10,
    height: 6,

    vx:
      dir * 220,

    vy: 0,

    damage:
      en.damage,

    weapon: 'enemy',

    range: 1000,

    traveled: 0,

    owner: undefined,

    pierce: false,

    dead: false,

    hitSlots:
      new Set()
  });

  ev(
    sim,
    {
      k: 'proj'
    }
  );
}

/* -----------------------------------------------------------------------------
   ENNEMIS
   ----------------------------------------------------------------------------- */

function pickEnemyType() {
  const r =
    Math.random();

  if (r < 0.55) {
    return ENEMY_TYPES.grunt;
  }

  if (r < 0.85) {
    return ENEMY_TYPES.rusher;
  }

  return ENEMY_TYPES.thrower;
}

function spawnEnemy(sim) {
  const t =
    pickEnemyType();

  const hp =
    t.hpBase +
    Math.floor(
      sim.score / 120
    ) *
      2;

  const fromLeft =
    Math.random() <
    0.5;

  const x =
    fromLeft
      ? 6
      : GAME_W -
        6 -
        t.width;

  sim.enemies.push({
    id:
      sim.nextId++,

    type: t.type,

    x,

    y:
      GROUND_Y -
      t.height,

    width:
      t.width,

    height:
      t.height,

    hp,

    maxHp: hp,

    speed:
      t.speed,

    damage:
      t.damage,

    atkRange:
      t.atkRange,

    atkCd:
      t.atkCd,

    points:
      t.points,

    ranged:
      !!t.ranged,

    lastAtk: 0,

    facing: 1,

    dead: false,

    deathFade:
      ENEMY_DEATH_VISUAL_MS,

    moving: false
  });
}

/* -----------------------------------------------------------------------------
   BOSS
   ----------------------------------------------------------------------------- */

function checkBossTrigger(
  sim
) {
  const tier =
    Math.floor(
      sim.score / 200
    );

  for (
    let t =
      sim.lastTierChecked +
      1;
    t <= tier;
    t++
  ) {
    if (
      !sim.rolledTiers.has(t)
    ) {
      sim.rolledTiers.add(t);

      if (
        !sim.boss &&
        Math.random() <
          BOSS_CHANCE
      ) {
        spawnBoss(
          sim,
          t
        );

        break;
      }
    }
  }

  sim.lastTierChecked =
    tier;
}

function spawnBoss(
  sim,
  tier
) {
  const hp =
    Math.round(
      (
        260 +
        tier * 40
      ) *
        COOP_BOSS_HP_MULT
    );

  const avgX =
    sim.players.reduce(
      (a, p) =>
        a + p.x,
      0
    ) /
    sim.players.length;

  sim.boss = {
    x:
      avgX <
      GAME_W / 2
        ? GAME_W - 76
        : 24,

    y:
      GROUND_Y - 112,

    width: 72,
    height: 112,

    hp,
    maxHp: hp,

    facing: -1,

    meleeDamage: 16,
    meleeRange: 58,
    meleeCd: 900,
    lastMelee: 0,

    slamDamage: 22,
    slamRadius: 150,
    slamCooldown: 4500,
    lastSlam:
      sim.now,

    speed: 66,

    points: 150,

    dead: false,

    deadAt: 0,

    state: 'chase',

    telegraphEnd: 0,

    slamEnd: 0,

    name: 'LE CAÏD',

    moving: false
  };

  sim.enemies.length =
    0;

  sim.spawnTimer =
    0;

  ev(
    sim,
    {
      k: 'bspawn',
      name:
        sim.boss.name
    }
  );
}

function damageEnemy(
  sim,
  en,
  dmg,
  special,
  atk
) {
  if (en.dead) {
    return;
  }

  en.hp -= dmg;

  ev(
    sim,
    {
      k: 'dmg',
      tk: 'e',
      id: en.id,
      d: dmg,
      x: r1(
        en.x +
          en.width / 2
      ),
      y: r1(en.y),
      s: atk.slot
    }
  );

  if (
    special ===
    'knockback'
  ) {
    en.x = clamp(
      en.x +
        atk.facing *
          26,
      0,
      GAME_W -
        en.width
    );
  }

  if (
    en.hp <= 0 &&
    !en.dead
  ) {
    en.dead = true;

    en.deathFade =
      ENEMY_DEATH_VISUAL_MS;

    sim.score +=
      en.points;

    spawnCoin(
      sim,
      en.x +
        en.width / 2,
      en.y +
        en.height *
          0.4,
      1
    );

    ev(
      sim,
      {
        k: 'edie',
        id: en.id,
        x: r1(
          en.x +
            en.width / 2
        ),
        y: r1(
          en.y +
            en.height *
              0.5
        )
      }
    );

    checkBossTrigger(
      sim
    );
  }
}

function damageBoss(
  sim,
  dmg,
  atk
) {
  const b =
    sim.boss;

  if (
    !b ||
    b.dead
  ) {
    return;
  }

  b.hp -= dmg;

  ev(
    sim,
    {
      k: 'dmg',
      tk: 'b',
      d: dmg,
      x: r1(
        b.x +
          b.width / 2
      ),
      y: r1(b.y),
      s: atk.slot
    }
  );

  if (b.hp <= 0) {
    b.hp = 0;

    b.dead = true;

    b.deadAt =
      sim.now;

    sim.score +=
      b.points;

    spawnCoin(
      sim,
      b.x +
        b.width / 2,
      b.y +
        b.height *
          0.3,
      100
    );

    ev(
      sim,
      {
        k: 'bdie',
        x: r1(
          b.x +
            b.width / 2
        ),
        y: r1(
          b.y +
            b.height *
              0.5
        )
      }
    );

    checkBossTrigger(
      sim
    );
  }
}

/* -----------------------------------------------------------------------------
   VISÉE
   ----------------------------------------------------------------------------- */

function normalizeAim(
  ax,
  ay,
  facing
) {
  let x =
    Number.isFinite(
      Number(ax)
    )
      ? Number(ax)
      : facing;

  let y =
    Number.isFinite(
      Number(ay)
    )
      ? Number(ay)
      : 0;

  const len =
    Math.hypot(
      x,
      y
    );

  if (
    len < 0.001
  ) {
    return {
      x: facing || 1,
      y: 0
    };
  }

  x /= len;
  y /= len;

  return {
    x,
    y
  };
}

/* -----------------------------------------------------------------------------
   PROJECTILES JOUEURS
   ----------------------------------------------------------------------------- */

function spawnPlayerProjectile(
  sim,
  p,
  weapon,
  ax,
  ay
) {
  const pellets =
    weapon.pellets || 1;

  const originX =
    p.x +
    p.width / 2 +
    ax * 18;

  const originY =
    p.y +
    p.height * 0.42 +
    ay * 8;

  for (
    let i = 0;
    i < pellets;
    i++
  ) {
    let dx = ax;
    let dy = ay;

    if (
      pellets > 1
    ) {
      const spread =
        (
          (
            i -
            (pellets - 1) /
              2
          ) /
          Math.max(
            1,
            pellets - 1
          )
        ) *
        (
          weapon.spread ||
          0
        );

      const a =
        Math.atan2(
          ay,
          ax
        ) +
        spread;

      dx =
        Math.cos(a);

      dy =
        Math.sin(a);
    }

    sim.projectiles.push({
      id:
        sim.nextId++,

      owner:
        p.slot,

      x:
        originX,

      y:
        originY,

      vx:
        dx *
        weapon.speed,

      vy:
        dy *
        weapon.speed,

      damage:
        Math.round(
          weapon.damage *
            CHARACTERS[
              p.char
            ].dmgMult
        ),

      weapon:
        weapon.id,

      range:
        weapon.range,

      traveled: 0,

      pierce:
        !!weapon.pierce,

      dead: false,

      hitSlots:
        new Set()
    });
  }
}

/* -----------------------------------------------------------------------------
   ATTAQUE
   ----------------------------------------------------------------------------- */

function playerAttack(
  room,
  p,
  ax,
  ay
) {
  const sim =
    room.sim;

  if (
    !sim ||
    sim.over ||
    sim.ending ||
    sim.cd > 0 ||
    !p.alive
  ) {
    return;
  }

  const weapon =
    WEAPONS[
      p.weapon
    ] ||
    WEAPONS.pistol;

  if (
    sim.now -
      p.lastAttack <
    weapon.cooldown *
      0.85
  ) {
    return;
  }

  const aim =
    normalizeAim(
      ax,
      ay,
      p.facing
    );

  p.ax =
    aim.x;

  p.ay =
    aim.y;

  if (
    aim.x < -0.05
  ) {
    p.facing = -1;
  } else if (
    aim.x > 0.05
  ) {
    p.facing = 1;
  }

  p.lastAttack =
    sim.now;

  const ch =
    CHARACTERS[
      p.char
    ];

  const dmg =
    Math.round(
      weapon.damage *
        ch.dmgMult *
        (
          sim.mode ===
          'duel'
            ? DUEL_DMG_MULT
            : 1
        )
    );

  let hit = false;

  if (
    weapon.ranged
  ) {
    spawnPlayerProjectile(
      sim,
      p,
      {
        ...weapon,
        damage: dmg
      },
      aim.x,
      aim.y
    );
  } else {
    const reach =
      weapon.range +
      HIT_FORGIVE;

    const hitboxX =
      p.facing === 1
        ? p.x +
          p.width
        : p.x -
          reach;

    const hitbox = {
      x: hitboxX,
      y: p.y,
      width: reach,
      height:
        p.height
    };

    if (
      (sim.mode === 'coop' || sim.mode === 'waves')
    ) {
      sim.enemies.forEach(
        en => {
          if (
            en.dead
          ) {
            return;
          }

          if (
            rectsIntersect(
              hitbox,
              en
            )
          ) {
            hit = true;

            damageEnemy(
              sim,
              en,
              dmg,
              weapon.special,
              p
            );
          }
        }
      );

      if (
        sim.boss &&
        !sim.boss.dead &&
        rectsIntersect(
          hitbox,
          sim.boss
        )
      ) {
        hit = true;

        damageBoss(
          sim,
          dmg,
          p
        );
      }
    } else {
      const opp =
        sim.players[
          1 - p.slot
        ];

      if (
        opp &&
        opp.alive &&
        rectsIntersect(
          hitbox,
          opp
        )
      ) {
        if (
          damagePlayer(
            sim,
            opp,
            dmg,
            p.x +
              p.width /
                2,
            weapon.special ===
              'knockback'
              ? 26
              : 14
          )
        ) {
          hit = true;
        }
      }
    }
  }

  ev(
    sim,
    {
      k: 'swing',

      s: p.slot,

      x: r1(
        p.x +
          p.width / 2 +
          aim.x * 28
      ),

      y: r1(
        p.y +
          p.height *
            0.42
      ),

      f: p.facing,

      w: weapon.id,

      ax:
        r1(aim.x),

      ay:
        r1(aim.y),

      hit:
        hit ? 1 : 0,

      d: dmg
    }
  );
}

/* -----------------------------------------------------------------------------
   SAUT
   ----------------------------------------------------------------------------- */

function playerJump(
  room,
  p
) {
  const sim =
    room.sim;

  if (
    !sim ||
    sim.over ||
    sim.ending ||
    sim.cd > 0 ||
    !p.alive
  ) {
    return;
  }

  if (p.onGround) {
    p.vy =
      BASE_JUMP_V *
      CHARACTERS[
        p.char
      ].jumpMult;

    p.onGround =
      false;

    ev(
      sim,
      {
        k: 'jump',
        s: p.slot
      }
    );
  }
}

/* -----------------------------------------------------------------------------
   UPDATE ENNEMIS
   ----------------------------------------------------------------------------- */

function updateEnemies(
  sim,
  dt
) {
  const now =
    sim.now;

  sim.enemies.forEach(
    en => {
      if (en.dead) {
        en.deathFade -=
          dt * 1000;

        return;
      }

      const tgt =
        nearestAlive(
          sim,
          en.x +
            en.width /
              2
        );

      en.moving =
        false;

      if (!tgt) {
        return;
      }

      const centerDX =
        tgt.x +
        tgt.width / 2 -
        (
          en.x +
          en.width / 2
        );

      const dist =
        Math.abs(
          centerDX
        );

      const dir =
        centerDX === 0
          ? 1
          : Math.sign(
              centerDX
            );

      en.facing =
        dir;

      if (en.ranged) {
        if (
          dist >
          en.atkRange *
            0.6
        ) {
          en.x +=
            dir *
            en.speed *
            dt;

          en.moving =
            true;
        }

        if (
          dist <=
            en.atkRange &&
          now -
            en.lastAtk >
            en.atkCd
        ) {
          en.lastAtk =
            now;

          ev(
            sim,
            {
              k: 'eatk',
              id: en.id
            }
          );

          spawnProjectile(
            sim,
            en,
            dir
          );
        }
      } else if (
        dist >
        en.atkRange
      ) {
        let spd =
          en.speed;

        if (
          en.type ===
            'rusher' &&
          dist < 190
        ) {
          spd *= 1.55;
        }

        en.x +=
          dir *
          spd *
          dt;

        en.moving =
          true;
      } else if (
        now -
          en.lastAtk >
        en.atkCd
      ) {
        en.lastAtk =
          now;

        ev(
          sim,
          {
            k: 'eatk',
            id: en.id
          }
        );

        damagePlayer(
          sim,
          tgt,
          en.damage,
          en.x
        );
      }

      sim.enemies.forEach(
        other => {
          if (
            other === en ||
            other.dead
          ) {
            return;
          }

          const dx =
            en.x -
            other.x;

          if (
            Math.abs(dx) <
              en.width *
                0.7 &&
            Math.abs(dx) >
              0.001
          ) {
            en.x +=
              Math.sign(
                dx
              ) *
              10 *
              dt;
          }
        }
      );

      en.x = clamp(
        en.x,
        0,
        GAME_W -
          en.width
      );
    }
  );
}

/* -----------------------------------------------------------------------------
   UPDATE BOSS
   ----------------------------------------------------------------------------- */

function updateBoss(
  sim,
  dt
) {
  const b =
    sim.boss;

  if (!b) {
    return;
  }

  const now =
    sim.now;

  if (b.dead) {
    if (
      now -
        b.deadAt >
      BOSS_DEATH_VISUAL_MS
    ) {
      sim.boss =
        null;
    }

    return;
  }

  const tgt =
    nearestAlive(
      sim,
      b.x +
        b.width / 2
    );

  b.moving =
    false;

  if (!tgt) {
    return;
  }

  const centerDX =
    tgt.x +
    tgt.width / 2 -
    (
      b.x +
      b.width / 2
    );

  const dist =
    Math.abs(
      centerDX
    );

  const dir =
    centerDX === 0
      ? 1
      : Math.sign(
          centerDX
        );

  b.facing =
    dir;

  if (
    b.state ===
    'chase'
  ) {
    if (
      dist >
      b.meleeRange
    ) {
      b.x +=
        dir *
        b.speed *
        dt;

      b.moving =
        true;
    } else if (
      now -
        b.lastMelee >
      b.meleeCd
    ) {
      b.lastMelee =
        now;

      ev(
        sim,
        {
          k: 'batk'
        }
      );

      damagePlayer(
        sim,
        tgt,
        b.meleeDamage,
        b.x
      );
    }

    if (
      now -
        b.lastSlam >
      b.slamCooldown
    ) {
      b.state =
        'telegraph';

      b.telegraphEnd =
        now + 700;
    }
  } else if (
    b.state ===
    'telegraph'
  ) {
    if (
      now >=
      b.telegraphEnd
    ) {
      b.state =
        'slam';

      b.slamEnd =
        now + 150;

      const bcx =
        b.x +
        b.width / 2;

      sim.players.forEach(
        p => {
          if (
            !p.alive
          ) {
            return;
          }

          if (
            p.onGround &&
            Math.abs(
              p.x +
                p.width /
                  2 -
                bcx
            ) <
              b.slamRadius
          ) {
            damagePlayer(
              sim,
              p,
              b.slamDamage,
              b.x
            );
          }
        }
      );

      ev(
        sim,
        {
          k: 'slam',
          x: r1(bcx)
        }
      );
    }
  } else if (
    b.state ===
    'slam'
  ) {
    if (
      now >=
      b.slamEnd
    ) {
      b.state =
        'chase';

      b.lastSlam =
        now;
    }
  }

  b.x = clamp(
    b.x,
    0,
    GAME_W -
      b.width
  );
}

/* -----------------------------------------------------------------------------
   UPDATE PROJECTILES
   ----------------------------------------------------------------------------- */

function updateProjectiles(
  sim,
  dt
) {
  sim.projectiles.forEach(
    pr => {
      if (pr.dead) {
        return;
      }

      const stepX =
        pr.vx * dt;

      const stepY =
        pr.vy * dt;

      pr.x += stepX;
      pr.y += stepY;

      pr.traveled +=
        Math.hypot(
          stepX,
          stepY
        );

      if (
        pr.traveled >
          pr.range ||
        pr.x < -50 ||
        pr.x >
          GAME_W + 50 ||
        pr.y < -80 ||
        pr.y >
          GAME_H + 80
      ) {
        pr.dead = true;
        return;
      }

      const hitbox = {
        x:
          pr.x - 5,

        y:
          pr.y - 3,

        width: 10,
        height: 6
      };

      if (
        sim.mode ===
        'duel'
      ) {
        const p =
          sim.players[
            1 - pr.owner
          ];

        if (
          p &&
          p.alive &&
          !pr.hitSlots.has(
            p.slot
          ) &&
          rectsIntersect(
            hitbox,
            p
          )
        ) {
          if (
            damagePlayer(
              sim,
              p,
              pr.damage,
              pr.x
            )
          ) {
            pr.hitSlots.add(
              p.slot
            );

            ev(
              sim,
              {
                k: 'phit',
                w: pr.weapon,
                x: r1(pr.x),
                y: r1(pr.y),
                d: pr.damage
              }
            );

            if (
              !pr.pierce
            ) {
              pr.dead =
                true;
            }
          }
        }
      } else {
        for (
          const en of
          sim.enemies
        ) {
          if (
            en.dead
          ) {
            continue;
          }

          if (
            rectsIntersect(
              hitbox,
              en
            )
          ) {
            damageEnemy(
              sim,
              en,
              pr.damage,
              null,
              sim.players[
                pr.owner
              ]
            );

            ev(
              sim,
              {
                k: 'phit',
                w: pr.weapon,
                x: r1(pr.x),
                y: r1(pr.y),
                d: pr.damage
              }
            );

            if (
              !pr.pierce
            ) {
              pr.dead =
                true;

              break;
            }
          }
        }

        if (
          !pr.dead &&
          sim.boss &&
          !sim.boss.dead &&
          rectsIntersect(
            hitbox,
            sim.boss
          )
        ) {
          damageBoss(
            sim,
            pr.damage,
            sim.players[
              pr.owner
            ]
          );

          ev(
            sim,
            {
              k: 'phit',
              w: pr.weapon,
              x: r1(pr.x),
              y: r1(pr.y),
              d: pr.damage
            }
          );

          if (
            !pr.pierce
          ) {
            pr.dead =
              true;
          }
        }
      }
    }
  );
}

/* -----------------------------------------------------------------------------
   COINS
   ----------------------------------------------------------------------------- */

function updateCoins(
  sim,
  dt
) {
  sim.coins.forEach(
    c => {
      c.vy +=
        900 * dt;

      c.y +=
        c.vy * dt;

      const restY =
        GROUND_Y - 14;

      if (
        c.y > restY
      ) {
        c.y =
          restY;

        c.vy = 0;
      }

      if (c.dead) {
        return;
      }

      for (
        const p of
        sim.players
      ) {
        if (
          !p.alive
        ) {
          continue;
        }

        if (
          rectsIntersect(
            c,
            p
          )
        ) {
          c.dead =
            true;

          p.coins +=
            c.value;

          ev(
            sim,
            {
              k: 'cget',
              s: p.slot,
              v: c.value,
              x: r1(
                c.x + 8
              ),
              y: r1(
                c.y + 8
              )
            }
          );

          break;
        }
      }
    }
  );
}

/* -----------------------------------------------------------------------------
   TICK
   ----------------------------------------------------------------------------- */

function stepSim(
  room,
  dt
) {
  const sim =
    room.sim;

  if (
    !sim ||
    sim.over ||
    sim.ending
  ) {
    return;
  }

  if (
    sim.cd > 0
  ) {
    sim.cd -=
      dt * 1000;

    if (
      sim.cd <= 0
    ) {
      sim.cd = 0;

      ev(
        sim,
        {
          k: 'go'
        }
      );

      if (
        process.env.START_BOSS &&
        sim.mode ===
          'coop'
      ) {
        spawnBoss(
          sim,
          1
        );
      }
    }

    return;
  }

  sim.now +=
    dt * 1000;

  sim.players.forEach(
    p =>
      updatePlayer(
        sim,
        p,
        dt
      )
  );

  if (
    (sim.mode === 'coop' || sim.mode === 'waves')
  ) {
    updateEnemies(
      sim,
      dt
    );

    updateBoss(
      sim,
      dt
    );

    updateProjectiles(
      sim,
      dt
    );

    updateCoins(
      sim,
      dt
    );

    if (!sim.boss) {
      sim.spawnTimer +=
        dt * 1000;

      const alive =
        sim.enemies.filter(
          e =>
            !e.dead
        ).length;

      if (sim.mode === 'waves' && sim.waveBreak > 0) {
        sim.waveBreak -= dt * 1000;
        if (sim.waveBreak <= 0) {
          sim.wave++;
          sim.waveSpawned = 0;
          sim.waveTarget = Math.min(12, 4 + sim.wave);
          sim.spawnTimer = sim.spawnInterval;
          ev(sim, { k:'wave', n:sim.wave, phase:'start' });
        }
      } else if (sim.spawnTimer >= sim.spawnInterval && alive < COOP_MAX_ENEMIES &&
          (sim.mode !== 'waves' || sim.waveSpawned < sim.waveTarget)) {
        sim.spawnTimer = 0;
        spawnEnemy(sim);
        if (sim.mode === 'waves') sim.waveSpawned++;
        sim.spawnInterval = Math.max(COOP_SPAWN_MIN, sim.spawnInterval - 35);
      }
      if (sim.mode === 'waves' && sim.waveSpawned >= sim.waveTarget && alive === 0 && !sim.boss && sim.waveBreak <= 0) {
        sim.waveBreak = 2500;
        ev(sim, { k:'wave', n:sim.wave, phase:'end' });
      }
    }

    sim.enemies =
      sim.enemies.filter(
        e =>
          !(
            e.dead &&
            e.deathFade <= 0
          )
      );

    sim.projectiles =
      sim.projectiles.filter(
        p =>
          !p.dead
      );

    sim.coins =
      sim.coins.filter(
        c =>
          !c.dead
      );

    if (sim.mode !== 'duel') {
      const down = sim.players.filter(p => !p.alive);
      const living = sim.players.filter(p => p.alive);
      if (down.length === 2) {
        sim.ending = { reason:'dead', winner:-1 };
      } else if (down.length === 1 && living.length === 1) {
        const p = down[0];
        p.reviveRemaining = Math.max(0, 5000 - (sim.now - (p.koAt || sim.now)));
        if (sim.now - (p.koAt || sim.now) >= 5000) {
          p.alive = true;
          p.hp = Math.max(1, Math.round(p.maxHp * 0.5));
          p.koAt = null;
          p.reviveRemaining = 0;
          p.invulnUntil = sim.now + 1200;
          p.x = clamp(living[0].x + (p.slot === 0 ? -42 : 42), 6, GAME_W - 6 - p.width);
          p.y = GROUND_Y - p.height; p.vx = 0; p.vy = 0; p.onGround = true;
          ev(sim, { k:'revive', s:p.slot, hp:p.hp });
        }
      }
    } else {
      const [a,b] = sim.players;
      if (!a.alive || !b.alive) {
        sim.ending = { reason:'ko', winner:a.alive ? 0 : b.alive ? 1 : -1 };
      }
    }
  } else {
    const [
      a,
      b
    ] =
      sim.players;

    if (
      !a.alive ||
      !b.alive
    ) {
      sim.ending = {
        reason: 'ko',

        winner:
          a.alive
            ? 0
            : b.alive
              ? 1
              : -1
      };
    }
  }
}

/* -----------------------------------------------------------------------------
   SNAPSHOT
   ----------------------------------------------------------------------------- */

function buildSnap(
  sim
) {
  const snap = {
    t: 'snap',

    proto: PROTO,

    ts:
      nowMs(),

    cd:
      Math.ceil(
        sim.cd / 1000
      ),

    sc:
      sim.score,
    wave: sim.wave || 1,

    p:
      sim.players.map(
        p => ({
          s: p.slot,

          x:
            r1(p.x),

          y:
            r1(p.y),

          vx:
            Math.round(
              p.vx
            ),

          vy:
            Math.round(
              p.vy
            ),

          f:
            p.facing,

          g:
            p.onGround
              ? 1
              : 0,

          hp:
            p.hp,

          a:
            p.alive
              ? 1
              : 0,
          rr: p.reviveRemaining || 0,

          iv:
            sim.now <
            p.invulnUntil
              ? 1
              : 0,

          c:
            p.coins,

          sp: {
            hp:
              p.hp,

            mh:
              p.maxHp,

            a:
              !!p.alive,

            iv:
              sim.now <
              p.invulnUntil,

            ax:
              r1(
                p.ax ||
                  p.facing
              ),

            ay:
              r1(
                p.ay || 0
              ),

            w:
              p.weapon
          }
        })
      ),

    e:
      sim.events
  };

  /* Projectiles :
     envoyés en COOP ET en DUEL. */

  snap.pr =
    sim.projectiles.map(
      p => ({
        i:
          p.id,

        x:
          r1(p.x),

        y:
          r1(p.y),

        vx:
          r1(p.vx),

        vy:
          r1(p.vy),

        w:
          p.weapon ||
          'enemy',

        pc:
          !!p.pierce,

        s:
          p.owner ===
          undefined
            ? -1
            : p.owner
      })
    );

  if (
    (sim.mode === 'coop' || sim.mode === 'waves')
  ) {
    snap.en =
      sim.enemies.map(
        e => ({
          i:
            e.id,

          ty:
            e.type,

          x:
            r1(e.x),

          y:
            r1(e.y),

          f:
            e.facing,

          h:
            e.hp,

          m:
            e.maxHp,

          d:
            e.dead
              ? 1
              : 0,

          mv:
            e.moving
              ? 1
              : 0
        })
      );

    const b =
      sim.boss;

    snap.bo =
      b
        ? {
            x:
              r1(b.x),

            y:
              r1(b.y),

            f:
              b.facing,

            h:
              b.hp,

            m:
              b.maxHp,

            d:
              b.dead
                ? 1
                : 0,

            mv:
              b.moving
                ? 1
                : 0,

            st:
              b.state,

            tl:
              b.state ===
              'telegraph'
                ? Math.max(
                    0,
                    Math.round(
                      b.telegraphEnd -
                        sim.now
                    )
                  )
                : 0,

            n:
              b.name
          }
        : null;

    snap.co =
      sim.coins.map(
        c => ({
          i:
            c.id,

          x:
            r1(c.x),

          y:
            r1(c.y),

          v:
            c.value
        })
      );
  }

  sim.events =
    [];

  return snap;
}

/* -----------------------------------------------------------------------------
   START
   ----------------------------------------------------------------------------- */

function startMessage(
  room,
  slot,
  resync
) {
  const sim =
    room.sim;

  return {
    t: 'start',

    proto: PROTO,

    mode:
      sim.mode,

    slot,

    resync:
      !!resync,

    chars:
      sim.players.map(
        p =>
          p.char
      ),

    weapons:
      sim.players.map(
        p =>
          p.weapon
      ),

    countdown:
      Math.ceil(
        sim.cd / 1000
      )
  };
}

function startGame(
  room
) {
  room.status =
    'playing';

  room.rematch = [
    false,
    false
  ];

  room.lastEnd =
    null;

  room.paused =
    false;

  room.snapAcc =
    0;

  room.seats.forEach(
    s => {
      if (s) {
        s.ready =
          false;
      }
    }
  );

  room.sim =
    createSim(room);

  room.seats.forEach(
    (s, i) =>
      sendSeat(
        s,
        startMessage(
          room,
          i,
          false
        )
      )
  );

  broadcast(
    room,
    roomInfo(room)
  );

  touch(room);
}

/* -----------------------------------------------------------------------------
   FIN DE PARTIE
   ----------------------------------------------------------------------------- */

function finishGame(
  room,
  reason,
  winner,
  leftSlot
) {
  const sim =
    room.sim;

  if (
    !sim ||
    sim.over
  ) {
    return;
  }

  sim.over =
    true;

  broadcast(
    room,
    buildSnap(sim)
  );

  const msg = {
    t: 'end',

    proto: PROTO,

    mode:
      sim.mode,

    reason,

    winner,

    score:
      sim.score,

    coins:
      sim.players.map(
        p =>
          p.coins
      ),

    left:
      leftSlot ===
      undefined
        ? -1
        : leftSlot
  };

  room.lastEnd =
    msg;

  room.status =
    'over';

  room.rematch = [
    false,
    false
  ];

  broadcast(
    room,
    msg
  );

  broadcast(
    room,
    roomInfo(room)
  );
}

/* -----------------------------------------------------------------------------
   TICK ROOM
   ----------------------------------------------------------------------------- */

function tickRoom(
  room,
  dt
) {
  stepSim(
    room,
    dt
  );

  const sim =
    room.sim;

  if (
    !sim ||
    sim.over
  ) {
    return;
  }

  if (sim.ending) {
    finishGame(
      room,
      sim.ending.reason,
      sim.ending.winner
    );

    return;
  }

  room.snapAcc +=
    dt;

  const step =
    1 / SNAP_HZ;

  if (
    room.snapAcc >=
    step - 0.0005
  ) {
    room.snapAcc =
      room.snapAcc >
      step * 3
        ? 0
        : room.snapAcc -
          step;

    broadcast(
      room,
      buildSnap(sim)
    );
  }
}

/* -----------------------------------------------------------------------------
   BOUCLE SIMULATION
   ----------------------------------------------------------------------------- */

let lastTick =
  nowMs();

setInterval(
  () => {
    const t =
      nowMs();

    const dt =
      Math.min(
        (
          t -
          lastTick
        ) / 1000,
        0.05
      );

    lastTick =
      t;

    for (
      const room of
      rooms.values()
    ) {
      if (
        room.status ===
          'playing' &&
        !room.paused &&
        room.sim
      ) {
        try {
          tickRoom(
            room,
            dt
          );
        } catch (e) {
          console.error(
            '[tick]',
            room.code,
            e
          );
        }
      }
    }
  },
  Math.round(
    1000 / SIM_HZ
  )
);

/* -----------------------------------------------------------------------------
   NETTOYAGE ROOMS
   ----------------------------------------------------------------------------- */

setInterval(
  () => {
    const t =
      Date.now();

    for (
      const room of
      Array.from(
        rooms.values()
      )
    ) {
      const connected =
        room.seats.filter(
          s =>
            s &&
            s.ws
        ).length;

      const idle =
        t -
        room.lastActivity;

      const limit =
        room.status ===
        'lobby'
          ? 15 *
            60 *
            1000
          : 60 *
            60 *
            1000;

      if (
        connected ===
          0 &&
        idle >
          RECONNECT_GRACE_MS +
            5000
      ) {
        destroyRoom(
          room
        );

        continue;
      }

      if (
        idle > limit &&
        room.status !==
          'playing'
      ) {
        room.seats.forEach(
          s => {
            if (
              s &&
              s.ws
            ) {
              send(
                s.ws,
                {
                  t: 'closed',
                  proto: PROTO,
                  why: 'idle'
                }
              );

              detach(s);
            }
          }
        );

        destroyRoom(
          room
        );
      }
    }
  },
  30000
);

/* -----------------------------------------------------------------------------
   CLASSEMENT PARTAGÉ (meilleure vague / meilleur score Arcade)
   Persistance : fichier JSON (LB_FILE, défaut ./leaderboard.json), écriture atomique.
   NB : sur un hébergement à disque éphémère (Render gratuit), le fichier est perdu
   à chaque redéploiement : monter un disque persistant et pointer LB_FILE dessus.
   Les parties solo tournent côté client : les contrôles ci-dessous (bornes, cohérence
   durée/valeur, limites de débit) réduisent la triche mais ne l'excluent pas.
   ----------------------------------------------------------------------------- */

const LB_FILE = process.env.LB_FILE || path.join(__dirname, 'leaderboard.json');
const LB_MAX_PLAYERS = 5000;
const LB_TOP = 50;
const LB_MAX_WAVE = 300;
const LB_MAX_SCORE = 3000000;
const LB_ID_RE = /^[a-z0-9]{16,32}$/;
const LB_NAME_RE = /^[\p{L}\p{N} _.\-]{3,16}$/u;
const lbPlayers = new Map();      // id -> { n, wave, waveAt, score, scoreAt }
const lbRate = new Map();         // ip -> { n, reset }
const lbLastById = new Map();     // id -> timestamp dernier envoi
let lbSaveTimer = null;

function lbCleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
}

function lbLoad() {
  try {
    const raw = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
    const src = raw && typeof raw.players === 'object' && raw.players ? raw.players : {};
    for (const id of Object.keys(src)) {
      const e = src[id];
      if (!LB_ID_RE.test(id) || !e) continue;
      const n = lbCleanName(e.n);
      if (!LB_NAME_RE.test(n)) continue;
      const wave = Number.isInteger(e.wave) && e.wave >= 1 && e.wave <= LB_MAX_WAVE ? e.wave : 0;
      const score = Number.isInteger(e.score) && e.score >= 1 && e.score <= LB_MAX_SCORE ? e.score : 0;
      if (!wave && !score) continue;
      lbPlayers.set(id, { n, wave, waveAt: +e.waveAt || 0, score, scoreAt: +e.scoreAt || 0 });
      if (lbPlayers.size >= LB_MAX_PLAYERS) break;
    }
    console.log('[leaderboard] ' + lbPlayers.size + ' joueur(s) chargé(s)');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[leaderboard] lecture impossible, démarrage à vide :', e.message);
  }
}

function lbSaveSoon() {
  if (lbSaveTimer) return;
  lbSaveTimer = setTimeout(() => {
    lbSaveTimer = null;
    try {
      const out = { v: 1, players: {} };
      for (const [id, e] of lbPlayers) out.players[id] = e;
      const tmp = LB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, LB_FILE);
    } catch (e) {
      console.error('[leaderboard] écriture impossible :', e.message);
    }
  }, 2000);
}

function lbRanked(kind) {
  const vk = kind === 'wave' ? 'wave' : 'score';
  const tk = vk + 'At';
  const arr = [];
  for (const [id, e] of lbPlayers) if (e[vk] > 0) arr.push({ id, n: e.n, v: e[vk], at: e[tk] });
  arr.sort((a, b) => b.v - a.v || a.at - b.at || (a.id < b.id ? -1 : 1));   // égalité : record atteint en premier
  return arr;
}

function lbSendBoard(ws, kind, id) {
  const arr = lbRanked(kind);
  const rows = arr.slice(0, LB_TOP).map((e, i) => ({ r: i + 1, n: e.n, v: e.v, me: !!(id && e.id === id) }));
  let me = null;
  if (id && LB_ID_RE.test(id)) {
    const i = arr.findIndex(e => e.id === id);
    if (i >= 0) me = { r: i + 1, n: arr[i].n, v: arr[i].v };
  }
  send(ws, { t: 'lb', kind, rows, me, total: arr.length });
}

function lbRateOk(ws) {
  const ip = ws.ip || 'x';
  const now = Date.now();
  let r = lbRate.get(ip);
  if (!r || now > r.reset) { r = { n: 0, reset: now + 600000 }; lbRate.set(ip, r); }
  r.n++;
  return r.n <= 30;
}

function lbHandle(ws, m) {
  const kind = m.kind === 'wave' || m.kind === 'score' ? m.kind : null;
  if (!kind) return;
  if (m.t === 'lb_get') {
    lbSendBoard(ws, kind, typeof m.id === 'string' ? m.id : '');
    return;
  }
  // lb_submit
  const fail = code => send(ws, { t: 'lb_ack', ok: false, kind, code });
  if (!lbRateOk(ws)) return fail('RATE');
  const id = typeof m.id === 'string' ? m.id : '';
  const name = lbCleanName(m.name);
  const v = m.v, dur = m.dur;
  if (!LB_ID_RE.test(id)) return fail('BAD_ID');
  if (!LB_NAME_RE.test(name)) return fail('BAD_NAME');
  if (!Number.isInteger(v) || v < 1) return fail('BAD_VALUE');
  if (!Number.isInteger(dur) || dur < 5 || dur > 86400) return fail('BAD_DURATION');
  if (kind === 'wave' && (v > LB_MAX_WAVE || v > 2 + dur / 4)) return fail('IMPLAUSIBLE');
  if (kind === 'score' && (v > LB_MAX_SCORE || v > 500 + dur * 350)) return fail('IMPLAUSIBLE');
  const now = Date.now();
  const rateKey = id + ':' + kind; // score et vague ont chacun leur limite
  if (now - (lbLastById.get(rateKey) || 0) < 2000) return fail('RATE');
  lbLastById.set(rateKey, now);
  if (lbLastById.size > 20000) lbLastById.clear();
  let e = lbPlayers.get(id);
  if (!e) {
    if (lbPlayers.size >= LB_MAX_PLAYERS) return fail('FULL');
    e = { n: name, wave: 0, waveAt: 0, score: 0, scoreAt: 0 };
    lbPlayers.set(id, e);
  }
  e.n = name;                                        // pseudo actualisé, identité (id) conservée
  const vk = kind, tk = kind + 'At';
  let improved = false;
  if (v > e[vk]) { e[vk] = v; e[tk] = now; improved = true; }   // uniquement les vrais records
  lbSaveSoon();
  send(ws, { t: 'lb_ack', ok: true, kind, improved });
  lbSendBoard(ws, kind, id);
}

lbLoad();

/* -----------------------------------------------------------------------------
   MESSAGES CLIENT -> SERVEUR
   ----------------------------------------------------------------------------- */

function handle(
  ws,
  m
) {
  const room =
    ws.room;

  const seat =
    ws.seat;

  switch (m.t) {
    case 'lb_get':
    case 'lb_submit':
      lbHandle(ws, m);
      return;

    case 'create':

      if (room) {
        sendErr(
          ws,
          'ALREADY',
          'Tu es déjà dans une partie.'
        );

        return;
      }

      createRoom(
        ws
      );

      return;

    case 'join':

      if (room) {
        sendErr(
          ws,
          'ALREADY',
          'Tu es déjà dans une partie.'
        );

        return;
      }

      joinRoom(
        ws,
        m.code
      );

      return;

    case 'resume':

      if (room) {
        return;
      }

      resumeRoom(
        ws,
        m.code,
        m.token
      );

      return;

    case 'leave':

      leaveRoom(
        ws,
        'left'
      );

      return;

    case 'ping':

      send(
        ws,
        {
          t: 'pong',
          proto: PROTO,
          c: m.c,
          s: nowMs()
        }
      );

      return;
  }

  if (
    !room ||
    !seat
  ) {
    return;
  }

  touch(room);

  switch (m.t) {
    case 'mode':

      if (
        seat.slot !==
          0 ||
        room.status !==
          'lobby'
      ) {
        return;
      }

      if (
        m.mode !==
          'coop' &&
        m.mode !==
          'duel' &&
        m.mode !==
          'waves'
      ) {
        return;
      }

      room.mode =
        m.mode;

      room.seats.forEach(
        s => {
          if (s) {
            s.ready =
              false;
          }
        }
      );

      broadcast(
        room,
        roomInfo(room)
      );

      return;

    case 'pick':

      if (
        room.status !==
        'lobby'
      ) {
        return;
      }

      if (
        CHARACTERS[
          m.char
        ]
      ) {
        seat.char =
          m.char;
      }

      seat.weapon =
        WEAPONS[
          m.weapon
        ]
          ? m.weapon
          : 'fists';

      seat.ready =
        false;

      broadcast(
        room,
        roomInfo(room)
      );

      return;

    case 'ready': {

      if (
        room.status !==
        'lobby'
      ) {
        return;
      }

      seat.ready =
        !!m.ready;

      broadcast(
        room,
        roomInfo(room)
      );

      const [
        a,
        b
      ] =
        room.seats;

      if (
        a &&
        b &&
        a.ws &&
        b.ws &&
        a.ready &&
        b.ready
      ) {
        startGame(
          room
        );
      }

      return;
    }

    case 'in': {

      if (
        room.status !==
          'playing' ||
        !room.sim
      ) {
        return;
      }

      const p =
        room.sim.players[
          seat.slot
        ];

      if (
        !p ||
        !p.alive
      ) {
        if (p) {
          p.l = 0;
          p.r = 0;
        }

        return;
      }

      p.l =
        m.l ? 1 : 0;

      p.r =
        m.r ? 1 : 0;

      return;
    }

    case 'jump':

      if (
        room.status ===
          'playing' &&
        room.sim
      ) {
        playerJump(
          room,
          room.sim.players[
            seat.slot
          ]
        );
      }

      return;

    case 'atk':

      if (
        room.status ===
          'playing' &&
        room.sim
      ) {
        playerAttack(
          room,
          room.sim.players[
            seat.slot
          ],
          m.ax,
          m.ay
        );
      }

      return;

    case 'rematch': {

      if (
        room.status !==
        'over'
      ) {
        return;
      }

      if (
        !room.seats[0] ||
        !room.seats[1]
      ) {
        return;
      }

      room.rematch[
        seat.slot
      ] = true;

      broadcast(
        room,
        {
          t: 'rematch',
          proto: PROTO,
          v:
            room.rematch
        }
      );

      if (
        room.rematch[0] &&
        room.rematch[1] &&
        room.seats[0].ws &&
        room.seats[1].ws
      ) {
        startGame(
          room
        );
      }

      return;
    }
  }
}

/* -----------------------------------------------------------------------------
   WEBSOCKET
   ----------------------------------------------------------------------------- */

wss.on(
  'connection',
  (ws, req) => {
    ws.ip = String((req && req.headers && req.headers['x-forwarded-for']) || (req && req.socket && req.socket.remoteAddress) || 'x').split(',')[0].trim().slice(0, 64);
    if (
      wss.clients.size >
      MAX_CLIENTS
    ) {
      ws.close(
        1013,
        'busy'
      );

      return;
    }

    ws.isAlive =
      true;

    ws.room =
      null;

    ws.seat =
      null;

    ws.bucket = {
      tokens: 120,
      last:
        Date.now()
    };

    ws.on(
      'pong',
      () => {
        ws.isAlive =
          true;
      }
    );

    ws.on(
      'message',
      (
        data,
        isBinary
      ) => {
        if (
          isBinary
        ) {
          return;
        }

        /* anti-flood :
           60 messages/s
           moyenne,
           rafale 120 */

        const t =
          Date.now();

        ws.bucket.tokens =
          Math.min(
            120,

            ws.bucket.tokens +
              (
                t -
                ws.bucket.last
              ) *
                0.06
          );

        ws.bucket.last =
          t;

        if (
          ws.bucket.tokens <
          1
        ) {
          return;
        }

        ws.bucket.tokens -=
          1;

        let m;

        try {
          m =
            JSON.parse(
              data.toString()
            );
        } catch (e) {
          return;
        }

        if (
          !m ||
          typeof m.t !==
            'string'
        ) {
          return;
        }

        try {
          handle(
            ws,
            m
          );
        } catch (e) {
          console.error(
            '[handle]',
            e
          );
        }
      }
    );

    ws.on(
      'close',
      () =>
        onSocketClose(
          ws
        )
    );

    ws.on(
      'error',
      () => {
        /* géré par close */
      }
    );

    send(
      ws,
      {
        t: 'hello',
        proto: PROTO,
        v: 2
      }
    );
  }
);

/* -----------------------------------------------------------------------------
   PING WEBSOCKET
   ----------------------------------------------------------------------------- */

setInterval(
  () => {
    wss.clients.forEach(
      ws => {
        if (
          ws.isAlive ===
          false
        ) {
          ws.terminate();
          return;
        }

        ws.isAlive =
          false;

        try {
          ws.ping();
        } catch (e) {}
      }
    );
  },
  10000
);

/* -----------------------------------------------------------------------------
   START SERVEUR
   ----------------------------------------------------------------------------- */

if (
  require.main ===
  module
) {
  server.listen(
    PORT,
    () => {
      console.log(
        'Bandana Fighters — serveur en ligne prêt sur le port ' +
          PORT
      );

      console.log(
        '  Jeu       : http://localhost:' +
          PORT +
          '/'
      );

      console.log(
        '  WebSocket : ws://localhost:' +
          PORT +
          '/'
      );

      console.log(
        '  Protocole : v' +
          PROTO
      );

      if (
        BOSS_CHANCE !==
        0.05
      ) {
        console.log(
          '  [debug] BOSS_CHANCE = ' +
            BOSS_CHANCE
        );
      }
    }
  );
}

/* -----------------------------------------------------------------------------
   EXPORTS
   ----------------------------------------------------------------------------- */

module.exports = {
  server,
  wss,
  rooms
};