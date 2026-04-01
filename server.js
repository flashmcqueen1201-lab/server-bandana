const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 10000,
  pingInterval: 5000,
});

// ==================== SUPABASE ====================
const SUPABASE_URL = 'https://xvieudrebskttwgqqrkf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2aWV1ZHJlYnNrdHR3Z3FxcmtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNDkyMDQsImV4cCI6MjA5MDYyNTIwNH0.zY0_WneTfvr2rylQdBkzCZJ1bNiOCYSjl20kXt4r9Bw';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== STATE ====================
const players = new Map(); // socketId -> { username, pseudo, online }
const rooms = new Map();   // roomId -> { id, hostId, players: [{socketId, username, pseudo, ready}], mode, status }

function genRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function safeEmit(socket, event, data) {
  if (socket && socket.connected) {
    socket.emit(event, data);
  }
}

function getRoomSnapshot(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    mode: room.mode,
    status: room.status,
    players: room.players.map(p => ({
      socketId: p.socketId,
      username: p.username,
      pseudo: p.pseudo,
      ready: p.ready,
    })),
  };
}

function broadcastRoom(room) {
  const snap = getRoomSnapshot(room);
  room.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.socketId);
    safeEmit(socket, 'room_update', snap);
  });
}

// ==================== AUTH MIDDLEWARE ====================
io.use(async (socket, next) => {
  const { username } = socket.handshake.auth;
  if (!username) return next(new Error('Missing username'));

  try {
    const { data, error } = await supabase
      .from('players')
      .select('username, pseudo, banned')
      .eq('username', username.toLowerCase())
      .single();

    if (error || !data) return next(new Error('Account not found'));
    if (data.banned) return next(new Error('Account banned'));

    socket.user = data;
    next();
  } catch (e) {
    next(new Error('Auth failed'));
  }
});

// ==================== CONNECTION ====================
io.on('connection', (socket) => {
  const { username, pseudo } = socket.handshake.auth;
  const uname = username.toLowerCase();

  console.log(`[+] ${uname} connected (${socket.id})`);

  // Mark online in Supabase
  supabase.from('players').update({ online: true }).eq('username', uname).then();

  players.set(socket.id, { username: uname, pseudo, online: true });

  // Send friend list on connect
  sendFriendList(socket, uname);

  // ==================== FRIEND INVITE ====================
  socket.on('invite_friend', async ({ targetUsername }) => {
    const target = targetUsername.toLowerCase();
    if (target === uname) return;

    // Check if already in a room together
    for (const [, room] of rooms) {
      if (room.players.some(p => p.username === uname) && room.players.some(p => p.username === target)) {
        safeEmit(socket, 'invite_error', { message: 'Vous êtes déjà dans la même partie.' });
        return;
      }
    }

    // Find target socket
    let targetSocket = null;
    for (const [sid, p] of players) {
      if (p.username === target) {
        targetSocket = io.sockets.sockets.get(sid);
        break;
      }
    }

    if (!targetSocket) {
      safeEmit(socket, 'invite_error', { message: 'Cet ami n\'est pas en ligne.' });
      return;
    }

    // Check if target already in a room
    let targetRoom = null;
    for (const [, room] of rooms) {
      if (room.players.some(p => p.username === target)) {
        targetRoom = room;
        break;
      }
    }

    if (targetRoom) {
      safeEmit(socket, 'invite_error', { message: 'Cet ami est déjà en partie.' });
      return;
    }

    // Send invitation
    const inviterPseudo = players.get(socket.id)?.pseudo || pseudo;
    safeEmit(targetSocket, 'invite_received', {
      fromUsername: uname,
      fromPseudo: inviterPseudo,
      roomId: null, // will be set when accepted
    });

    safeEmit(socket, 'invite_sent', { targetUsername: target });
  });

  // ==================== ACCEPT INVITE ====================
  socket.on('accept_invite', ({ fromUsername }) => {
    const from = fromUsername.toLowerCase();

    // Find the inviter's room or create one
    let room = null;
    for (const [, r] of rooms) {
      if (r.players.some(p => p.username === from)) {
        room = r;
        break;
      }
    }

    if (!room) {
      // Create a new room with both players
      const roomId = genRoomId();
      const inviterSocket = null;
      for (const [sid, p] of players) {
        if (p.username === from) {
          room = {
            id: roomId,
            hostId: sid,
            players: [
              { socketId: sid, username: from, pseudo: p.pseudo, ready: false },
              { socketId: socket.id, username: uname, pseudo, ready: false },
            ],
            mode: 'coop2',
            status: 'waiting',
          };
          rooms.set(roomId, room);
          break;
        }
      }
    } else {
      // Join existing room
      if (room.players.length >= 4) {
        safeEmit(socket, 'invite_error', { message: 'La partie est pleine.' });
        return;
      }
      room.players.push({ socketId: socket.id, username: uname, pseudo, ready: false });
    }

    if (room) {
      broadcastRoom(room);
      // Notify both players
      const snap = getRoomSnapshot(room);
      safeEmit(socket, 'room_joined', snap);
      room.players.forEach(p => {
        const s = io.sockets.sockets.get(p.socketId);
        if (s && p.username !== uname) {
          safeEmit(s, 'player_joined_room', { username: uname, pseudo, room: snap });
        }
      });
    }
  });

  // ==================== DECLINE INVITE ====================
  socket.on('decline_invite', ({ fromUsername }) => {
    const from = fromUsername.toLowerCase();
    for (const [sid, p] of players) {
      if (p.username === from) {
        const s = io.sockets.sockets.get(sid);
        safeEmit(s, 'invite_declined', { byUsername: uname, byPseudo: pseudo });
        break;
      }
    }
  });

  // ==================== CREATE ROOM ====================
  socket.on('create_room', ({ mode }) => {
    // Leave existing room if any
    leaveAllRooms(socket.id);

    const roomId = genRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      players: [{ socketId: socket.id, username: uname, pseudo, ready: false }],
      mode: mode || 'coop2',
      status: 'waiting',
    };
    rooms.set(roomId, room);
    safeEmit(socket, 'room_created', getRoomSnapshot(room));
    console.log(`[Room] ${roomId} created by ${uname}`);
  });

  // ==================== SET MODE ====================
  socket.on('set_mode', ({ roomId, mode }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.mode = mode;
    broadcastRoom(room);
  });

  // ==================== READY ====================
  socket.on('set_ready', ({ roomId, ready }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    player.ready = ready;
    broadcastRoom(room);
  });

  // ==================== START GAME ====================
  socket.on('start_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) {
      safeEmit(socket, 'error', { message: 'Il faut au moins 2 joueurs.' });
      return;
    }

    room.status = 'playing';
    const seed = Math.floor(Math.random() * 999999);
    const snap = getRoomSnapshot(room);

    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      safeEmit(s, 'game_started', {
        room: snap,
        seed,
        mode: room.mode,
      });
    });

    console.log(`[Game] Started in ${roomId} with ${room.players.length} players`);
  });

  // ==================== LEAVE ROOM ====================
  socket.on('leave_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    removePlayerFromRoom(socket.id, room);
  });

  // ==================== IN-GAME STATE ====================
  socket.on('player_state', ({ roomId, state }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    // Broadcast to other players in the room
    room.players.forEach(p => {
      if (p.socketId !== socket.id) {
        const s = io.sockets.sockets.get(p.socketId);
        safeEmit(s, 'player_state', { playerId: socket.id, state });
      }
    });
  });

  socket.on('game_event', ({ roomId, event }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    room.players.forEach(p => {
      if (p.socketId !== socket.id) {
        const s = io.sockets.sockets.get(p.socketId);
        safeEmit(s, 'game_event', { playerId: socket.id, event });
      }
    });
  });

  // ==================== DISCONNECT ====================
  socket.on('disconnect', () => {
    console.log(`[-] ${uname} disconnected (${socket.id})`);
    players.delete(socket.id);
    removePlayerFromRoom(socket.id);

    // Mark offline in Supabase
    supabase.from('players').update({ online: false }).eq('username', uname).then();
  });
});

// ==================== HELPERS ====================
function leaveAllRooms(socketId) {
  for (const [, room] of rooms) {
    removePlayerFromRoom(socketId, room);
  }
}

function removePlayerFromRoom(socketId, room) {
  if (!room) {
    // Find the room
    for (const [, r] of rooms) {
      const idx = r.players.findIndex(p => p.socketId === socketId);
      if (idx !== -1) {
        removePlayerFromRoom(socketId, r);
        return;
      }
    }
    return;
  }

  const idx = room.players.findIndex(p => p.socketId === socketId);
  if (idx === -1) return;

  const wasHost = room.players[idx].isHost || room.hostId === socketId;
  room.players.splice(idx, 1);

  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }

  // Re-assign host if needed
  if (wasHost && room.players.length > 0) {
    room.hostId = room.players[0].socketId;
  }

  if (room.status === 'playing' && room.players.length < 2) {
    // Not enough players, cancel game
    room.status = 'waiting';
    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      safeEmit(s, 'game_cancelled', { reason: 'Pas assez de joueurs.' });
    });
  }

  broadcastRoom(room);
}

async function sendFriendList(socket, username) {
  try {
    const { data, error } = await supabase
      .from('players')
      .select('username, pseudo, online')
      .eq('username', username)
      .single();

    if (!data || error) return;

    // Parse friends list
    let friends = [];
    try {
      const raw = data.friends;
      friends = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
    } catch (e) {}

    // Fetch online status for each friend
    const friendData = [];
    for (const friendUsername of friends) {
      const { data: fd } = await supabase
        .from('players')
        .select('username, pseudo, online')
        .eq('username', friendUsername.toLowerCase())
        .single();
      if (fd) {
        friendData.push({
          username: fd.username,
          pseudo: fd.pseudo,
          online: fd.online,
          inRoom: false, // will be set below
        });
      }
    }

    // Check which friends are in rooms
    for (const fd of friendData) {
      for (const [, room] of rooms) {
        if (room.players.some(p => p.username === fd.username)) {
          fd.inRoom = true;
          break;
        }
      }
    }

    safeEmit(socket, 'friend_list', { friends: friendData });
  } catch (e) {
    console.error('sendFriendList error:', e);
  }
}

// ==================== START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Bandana Fighters Socket.IO server running on port ${PORT}`);
});
