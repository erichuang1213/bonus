const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

const waitingPlayers = [];
const rooms = new Map();
const disconnectTimers = new Map();
const roomCleanupTimers = new Map();

// --- 遊戲物理常數 ---
const ARENA_SIZE = 750;
const BALL_RADIUS = 70;
const BODY_DAMAGE = 50;
const MAGMA_POOL_LIFETIME = 180;
const MAGMA_POOL_DAMAGE = 10;
const MAGMA_POOL_DAMAGE_INTERVAL = 30;
const ARENA_DAMAGE = 50;
const ARENA_DAMAGE_INTERVAL = 30;
const BLACK_HOLE_DAMAGE = 25;
const BLACK_HOLE_DAMAGE_INTERVAL = 15;
const EFFECTS_BROADCAST_INTERVAL = 3;
const FRENZY_REFLECT_RATIO = 0.02;
const FRENZY_HIT_ENERGY = 5;
const ALLOWED_ROLES = new Set(["speeder", "tank", "frenzy", "magma", "nova", "clone"]);
const MAX_NAME_LENGTH = 24;
const MAX_IMAGE_DATA_LENGTH = 300_000;
const HIT_RULES = {
  clone: { role: "clone", maxDamage: 5, energy: 0, cooldown: 10 },
  sword: { role: "frenzy", maxDamage: 20, energy: 10, cooldown: 90, range: 250 },
  magma: { role: "magma", maxDamage: 10, energy: 1, cooldown: 30, range: 210 },
  arena: { role: "magma", maxDamage: 50, energy: 1, cooldown: 30, range: 230 },
  blackHole: { role: "nova", maxDamage: 25, energy: 2, cooldown: 15, range: 160 },
  missile: { role: "clone", maxDamage: 25, energy: 10, cooldown: 120 },
  bigMissile: { role: "clone", maxDamage: 500, energy: 0, cooldown: 480 },
};

function cleanName(value) {
  return String(value || "玩家").trim().slice(0, MAX_NAME_LENGTH) || "玩家";
}

function isSafeImageData(value) {
  return !value || (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_DATA_LENGTH &&
    /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)
  );
}

function makeRoomId() {
  return "room_" + crypto.randomBytes(12).toString("hex");
}
function makePlayerKey() {
  return "pk_" + crypto.randomBytes(32).toString("base64url");
}
function removeFromQueue(socketId) {
  const index = waitingPlayers.findIndex((p) => p.socketId === socketId);
  if (index !== -1) waitingPlayers.splice(index, 1);
}

function serializePlayer(p) {
  return {
    side: p.side,
    name: p.name,
    selectedRole: p.selectedRole,
    imageData: p.imageData || "",
    ready: p.ready,
    connected: p.connected,
  };
}

function serializeMe(p) {
  return { ...serializePlayer(p), playerKey: p.playerKey };
}

function emitToPlayer(socketId, event, room, player) {
  io.to(socketId).emit(event, {
    roomId: room.roomId,
    phase: room.phase,
    me: serializeMe(player),
    players: room.players.map(serializePlayer),
  });
}

function getOwnedPlayer(room, socket, playerKey) {
  return room.players.find(
    (player) =>
      player.playerKey === playerKey &&
      player.socketId === socket.id &&
      player.connected,
  );
}

function scheduleRoomCleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.some((player) => player.connected)) return;
  if (roomCleanupTimers.has(roomId)) return;
  roomCleanupTimers.set(roomId, setTimeout(() => {
    const latestRoom = rooms.get(roomId);
    if (latestRoom && latestRoom.players.every((player) => !player.connected)) {
      rooms.delete(roomId);
    }
    roomCleanupTimers.delete(roomId);
  }, 30_000));
}

function emitRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players.filter((player) => player.connected).forEach((player) => {
    emitToPlayer(player.socketId, "roomState", room, player);
  });
}

// 🟢 伺服器端統一計算能量與觸發大招，並直接算好絕對座標！
// 🟢 伺服器端統一計算能量與觸發大招
// 🟢 伺服器端統一計算能量與觸發大招
// 🟢 伺服器端統一計算能量與觸發大招
// 🟢 伺服器端統一計算能量與觸發大招
function addServerEnergy(roomId, ballId, amount) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== "battle" || !room.gameState) return;
  const ball = room.gameState.balls.find((b) => b.id === ballId);
  if (!ball) return;

  if (!Number.isFinite(amount) || amount <= 0) return;
  ball.energy = Math.min(100, ball.energy + amount);
  if (ball.energy >= 100) {
    ball.energy = 0; // 能量滿，重置

    if (ball.role === "clone") {
      const cloneData = [];
      const cloneCount = Math.floor(Math.random() * 8) + 3;
      const cloneRadius = BALL_RADIUS * 0.72;
      const cloneSpeed = 10 * 0.95;
      for (let i = 0; i < cloneCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distOff = Math.random() * 36;
        const dir = Math.random() * Math.PI * 2;
        const tag = "c_" + Math.random().toString(36).slice(2, 8);
        let spawnX =
          ball.x + Math.cos(angle) * (BALL_RADIUS + cloneRadius + 16 + distOff);
        let spawnY =
          ball.y + Math.sin(angle) * (BALL_RADIUS + cloneRadius + 16 + distOff);
        spawnX = Math.max(
          cloneRadius,
          Math.min(ARENA_SIZE - cloneRadius, spawnX),
        );
        spawnY = Math.max(
          cloneRadius,
          Math.min(ARENA_SIZE - cloneRadius, spawnY),
        );
        cloneData.push({
          x: spawnX,
          y: spawnY,
          vx: Math.cos(dir) * cloneSpeed,
          vy: Math.sin(dir) * cloneSpeed,
          tag: tag,
        });
      }
      io.to(roomId).emit("triggerUltimate", {
        playerId: ballId,
        role: "clone",
        cloneData,
      });
    } else if (ball.role === "magma") {
      const enemy = room.gameState.balls.find((b) => b.id !== ballId);
      if (enemy) {
        // 1. 禁錮對手 3 秒 (180 幀)
        enemy.rootTimer = 180;

        // 🟢 幫熔岩巨獸加上 2.5 秒 (150幀) 的施法定身，保證絕對不會飄走！
        ball.rootTimer = 150;

        // 2. 瞬間貼臉：將距離設定為 141
        const angle = Math.random() * Math.PI * 2;
        ball.x = Math.max(
          BALL_RADIUS,
          Math.min(ARENA_SIZE - BALL_RADIUS, enemy.x + Math.cos(angle) * 141),
        );
        ball.y = Math.max(
          BALL_RADIUS,
          Math.min(ARENA_SIZE - BALL_RADIUS, enemy.y + Math.sin(angle) * 141),
        );

        // 瞬移後保持靜止
        ball.vx = 0;
        ball.vy = 0;

        // 3. 設定 2.5 秒 (150 幀) 後的彈開排程器
        enemy.magmaUltTimer = 150;
        enemy.magmaAttackerId = ballId;
        room.gameState.colosseum = {
          active: true,
          timer: 150,
          x: enemy.x,
          y: enemy.y,
          ownerTag: ballId,
          nextDamageFrame: room.gameState.frame,
        };

        io.to(roomId).emit("triggerUltimate", {
          playerId: ballId,
          role: "magma",
          targetX: enemy.x,
          targetY: enemy.y,
          magmaX: ball.x,
          magmaY: ball.y,
          magmaVX: 0,
          magmaVY: 0,
        });
      }
    } else if (ball.role === "nova") {
      room.gameState.blackHole = {
        active: true,
        timer: 240,
        x: ARENA_SIZE / 2,
        y: ARENA_SIZE / 2,
        ownerTag: ballId,
        nextDamageFrame: room.gameState.frame,
      };
      io.to(roomId).emit("triggerUltimate", {
        playerId: ballId,
        role: "nova",
        targetX: ARENA_SIZE / 2,
        targetY: ARENA_SIZE / 2,
      });
    } else {
      ball.ultimateNonce = (ball.ultimateNonce || 0) + 1;
      io.to(roomId).emit("triggerUltimate", {
        playerId: ballId,
        role: ball.role,
        ultimateNonce: ball.ultimateNonce,
      });
    }
  } // 結束 if (ball.energy >= 100)
} // 結束 function addServerEnergy

function applyServerDamage(roomId, targetId, attackerId, damage, energyGain = 0) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== "battle" || !room.gameState) return;
  const safeDamage = Math.max(0, Math.min(500, Number(damage) || 0));
  const safeEnergyGain = Math.max(0, Math.min(10, Number(energyGain) || 0));
  if (safeDamage <= 0) return;

  const targetBall = room.gameState.balls.find((ball) => ball.id === targetId);
  const attackerBall = room.gameState.balls.find((ball) => ball.id === attackerId);
  if (!targetBall || !attackerBall || targetId === attackerId) return;

  targetBall.hp = Math.max(0, targetBall.hp - safeDamage);
  room.gameState.stats[targetId].totalDamageTaken += safeDamage;
  room.gameState.stats[attackerId].totalDamageDealt += safeDamage;
  if (safeEnergyGain > 0) addServerEnergy(roomId, attackerId, safeEnergyGain);

  // 先確認本次正常傷害造成的死亡；死亡後不觸發受擊型被動。
  if (targetBall.hp <= 0) {
    finishBattle(roomId, attackerId, targetId);
    return;
  }

  // 狂暴的常駐被動：活著承受一次有效傷害時，回能並反射該次傷害的 2%。
  // 直接結算反傷，避免兩名狂暴互相反射造成遞迴傷害。
  if (targetBall.role === "frenzy" && targetBall.hp > 0 && room.phase === "battle") {
    addServerEnergy(roomId, targetId, FRENZY_HIT_ENERGY);
    const reflectDamage = safeDamage * FRENZY_REFLECT_RATIO;
    attackerBall.hp = Math.max(0, attackerBall.hp - reflectDamage);
    room.gameState.stats[attackerId].totalDamageTaken += reflectDamage;
    room.gameState.stats[targetId].totalDamageDealt += reflectDamage;
    io.to(roomId).emit("damageReflected", {
      fromId: targetId,
      toId: attackerId,
      damage: reflectDamage,
    });

    if (attackerBall.hp <= 0) {
      finishBattle(roomId, targetId, attackerId);
      return;
    }
  }
}

function finishBattle(roomId, winnerId, loserId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== "battle" || !room.gameState) return;
  room.phase = "finished";
  room.gameState.winnerId = winnerId;
  room.gameState.loserId = loserId;
  io.to(roomId).emit("battleEnded", {
    winnerId,
    loserId,
    stats: room.gameState.stats,
  });
  emitRoomState(roomId);
}

function getBodyDamage(ball) {
  if (ball.role === "clone") return 0;
  if (ball.role === "magma") return 10;
  return BODY_DAMAGE;
}

function validateReportedHit(room, attackerId, targetId, damage, hitType) {
  const rule = HIT_RULES[hitType];
  if (!rule || !Number.isFinite(damage) || damage <= 0 || damage > rule.maxDamage) return null;
  const attacker = room.gameState.balls.find((ball) => ball.id === attackerId);
  const target = room.gameState.balls.find((ball) => ball.id === targetId);
  if (!attacker || !target || attacker.role !== rule.role) return null;
  if (rule.range && Math.hypot(attacker.x - target.x, attacker.y - target.y) > rule.range) return null;

  const key = `${attackerId}:${hitType}`;
  const lastFrame = room.gameState.hitCooldowns?.[key] ?? -Infinity;
  if (room.gameState.frame - lastFrame < rule.cooldown) return null;
  room.gameState.hitCooldowns[key] = room.gameState.frame;
  return rule;
}

function consumeRateLimit(room, key, limit, windowFrames) {
  const frame = room.gameState.frame;
  room.gameState.rateLimits ||= {};
  const record = room.gameState.rateLimits[key] || { frame, amount: 0 };
  if (frame - record.frame >= windowFrames) {
    record.frame = frame;
    record.amount = 0;
  }
  if (record.amount >= limit) return false;
  record.amount++;
  room.gameState.rateLimits[key] = record;
  return true;
}

function updateServerEffects(roomId, room) {
  const state = room.gameState;
  const balls = state.balls;

  for (const ball of balls) {
    if (ball.role !== "magma") continue;
    if (!ball.lastMagmaPool) {
      ball.lastMagmaPool = { x: ball.x, y: ball.y };
      continue;
    }
    const last = ball.lastMagmaPool;
    if (Math.hypot(ball.x - last.x, ball.y - last.y) > 35) {
      state.magmaPools.push({
        x: ball.x,
        y: ball.y,
        life: MAGMA_POOL_LIFETIME,
        ownerTag: ball.id,
      });
      ball.lastMagmaPool = { x: ball.x, y: ball.y };
    }
  }

  for (let i = state.magmaPools.length - 1; i >= 0; i--) {
    const pool = state.magmaPools[i];
    pool.life--;
    if (pool.life <= 0) state.magmaPools.splice(i, 1);
  }

  for (const target of balls) {
    const pool = state.magmaPools.find((candidate) =>
      candidate.ownerTag !== target.id &&
      Math.hypot(target.x - candidate.x, target.y - candidate.y) <= BALL_RADIUS + 48,
    );
    if (!pool || state.frame < (target.magmaBurnUntil || 0)) continue;
    target.magmaBurnUntil = state.frame + MAGMA_POOL_DAMAGE_INTERVAL;
    applyServerDamage(roomId, target.id, pool.ownerTag, MAGMA_POOL_DAMAGE, 1);
  }

  const arena = state.colosseum;
  if (arena?.active) {
    arena.timer--;
    if (arena.timer <= 0) arena.active = false;
    else if (state.frame >= arena.nextDamageFrame) {
      const target = balls.find((ball) => ball.id !== arena.ownerTag);
      if (target && Math.hypot(target.x - arena.x, target.y - arena.y) < 120) {
        applyServerDamage(roomId, target.id, arena.ownerTag, ARENA_DAMAGE, 1);
      }
      arena.nextDamageFrame = state.frame + ARENA_DAMAGE_INTERVAL;
    }
  }

  const blackHole = state.blackHole;
  if (blackHole?.active && state.frame >= (blackHole.nextDamageFrame || 0)) {
    const target = balls.find((ball) => ball.id !== blackHole.ownerTag);
    if (target && Math.hypot(target.x - blackHole.x, target.y - blackHole.y) < BALL_RADIUS + 40) {
      applyServerDamage(roomId, target.id, blackHole.ownerTag, BLACK_HOLE_DAMAGE, 2);
    }
    blackHole.nextDamageFrame = state.frame + BLACK_HOLE_DAMAGE_INTERVAL;
  }
}
function maybeStartBattle(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== "character-select") return;

  const allSelected = room.players.every((p) => !!p.selectedRole);
  const allReady = room.players.every((p) => p.ready === true);

  if (allSelected && allReady) {
    const p1 = room.players.find((p) => p.side === "p1");
    const p2 = room.players.find((p) => p.side === "p2");
    if (!p1 || !p2) return;

    room.phase = "battle";
    room.gameState = {
      frame: 0,
      hitCooldowns: {},
      rateLimits: {},
      magmaPools: [],
      colosseum: null,
      openingFrames: 0, // 🟢 新增：進場動畫計時器
      balls: [
        // 🟢 加入 baseSpeed: 12.2 (這是 10 和 -7 向量算出來的預設總速度)
        {
          id: "p1",
          x: 175,
          y: 575,
          vx: 10,
          vy: -7,
          baseSpeed: 12.2,
          hp: 2000,
          maxHp: 2000,
          energy: 0,
          ultimateNonce: 0,
          role: p1.selectedRole,
          rootTimer: 0,
        },
        {
          id: "p2",
          x: 575,
          y: 175,
          vx: -10,
          vy: 7,
          baseSpeed: 12.2,
          hp: 2000,
          maxHp: 2000,
          energy: 0,
          ultimateNonce: 0,
          role: p2.selectedRole,
          rootTimer: 0,
        },
      ],
      stats: {
        p1: { totalDamageDealt: 0, totalDamageTaken: 0, totalHealing: 0 },
        p2: { totalDamageDealt: 0, totalDamageTaken: 0, totalHealing: 0 },
      },
    };
    room.players.forEach((player) => emitToPlayer(player.socketId, "battleStart", room, player));
    emitRoomState(roomId);
  }
}

io.on("connection", (socket) => {
  socket.on("joinQueue", (playerData = {}) => {
    removeFromQueue(socket.id);
    if ([...rooms.values()].some((room) => room.players.some((p) => p.socketId === socket.id && p.connected))) {
      return socket.emit("roomError", { message: "你已在進行中的房間內" });
    }
      const player = {
        socketId: socket.id,
        playerKey: playerData.playerKey || makePlayerKey(),
        name: cleanName(playerData.name),
        selectedRole: ALLOWED_ROLES.has(playerData.role) ? playerData.role : null,
    };
    if (!player.selectedRole) {
      return socket.emit("roomError", { message: "請先選擇有效角色再開始配對" });
    }

    if (waitingPlayers.length > 0) {
      const enemy = waitingPlayers.shift();
      const roomId = makeRoomId();
      const roomData = {
        roomId,
        phase: "character-select",
        players: [
          {
            socketId: enemy.socketId,
            playerKey: enemy.playerKey,
            side: "p1",
            name: enemy.name,
            selectedRole: enemy.selectedRole,
            ready: false,
            connected: true,
          },
          {
            socketId: socket.id,
            playerKey: player.playerKey,
            side: "p2",
            name: player.name,
            selectedRole: player.selectedRole,
            ready: false,
            connected: true,
          },
        ],
      };
      rooms.set(roomId, roomData);
      socket.join(roomId);
      const enemySocket = io.sockets.sockets.get(enemy.socketId);
      if (enemySocket) enemySocket.join(roomId);

      roomData.players.forEach((p) => emitToPlayer(p.socketId, "gameStart", roomData, p));
      emitRoomState(roomId);
    } else {
      waitingPlayers.push(player);
      socket.emit("queueJoined", {
        message: "等待另一位玩家...",
        playerKey: player.playerKey,
      });
    }
  });

  socket.on("rejoinRoom", ({ roomId, playerKey }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("roomError", { message: "找不到房間" });
    const me = room.players.find((p) => p.playerKey === playerKey);
    if (!me) return socket.emit("roomError", { message: "你不在這個房間內" });

    const timerKey = `${roomId}:${playerKey}`;
    if (disconnectTimers.has(timerKey)) {
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
    }
    me.socketId = socket.id;
    me.connected = true;
    if (roomCleanupTimers.has(roomId)) {
      clearTimeout(roomCleanupTimers.get(roomId));
      roomCleanupTimers.delete(roomId);
    }
    socket.join(roomId);
    emitToPlayer(socket.id, "roomJoined", room, me);
    emitRoomState(roomId);
  });

  socket.on("selectRole", ({ roomId, playerKey, role, imageData }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "character-select") return;
    const me = getOwnedPlayer(room, socket, playerKey);
    if (!me || !ALLOWED_ROLES.has(role) || !isSafeImageData(imageData)) return;
    // 線上角色在大廳鎖定。此事件只保留給舊頁面相容性，禁止覆寫既有選擇。
    if (me.selectedRole && me.selectedRole !== role) return;
    me.selectedRole = role;
    me.imageData = imageData || "";
    me.ready = true;
    emitRoomState(roomId);
    maybeStartBattle(roomId);
  });

  socket.on("playerReady", ({ roomId, playerKey }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "character-select") return;
    const me = getOwnedPlayer(room, socket, playerKey);
    if (!me || !me.selectedRole) return;
    me.ready = true;
    emitRoomState(roomId);
    maybeStartBattle(roomId);
  });
  // 🟢 新增：處理玩家請求重新對戰的邏輯
  socket.on("requestRematch", ({ roomId, playerKey }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "finished") return;

    const me = getOwnedPlayer(room, socket, playerKey);
    if (!me) return;

    // 標記該玩家已同意重新對戰
    me.rematchReady = true;

    // 檢查是不是兩個人都同意了
    const allReadyForRematch = room.players.every(
      (p) => p.rematchReady === true,
    );

    if (allReadyForRematch) {
      // 兩人都同意，重置伺服器端的遊戲狀態
      room.gameState.frame = 0;
      room.gameState.openingFrames = 0;
      room.gameState.lastCollisionFrame = 0;
      room.gameState.hitCooldowns = {};
      room.gameState.rateLimits = {};
      room.gameState.blackHole = null;
      room.gameState.magmaPools = [];
      room.gameState.colosseum = null;
      delete room.gameState.winnerId;
      delete room.gameState.loserId;

      // 重置球體狀態 (回到初始座標與血量)
      const p1 = room.players.find((p) => p.side === "p1");
      const p2 = room.players.find((p) => p.side === "p2");
      room.gameState.balls = [
        {
          id: "p1",
          x: 175,
          y: 575,
          vx: 10,
          vy: -7,
          baseSpeed: 12.2,
          hp: 2000,
          maxHp: 2000,
          energy: 0,
          ultimateNonce: 0,
          role: p1.selectedRole,
          rootTimer: 0,
        },
        {
          id: "p2",
          x: 575,
          y: 175,
          vx: -10,
          vy: 7,
          baseSpeed: 12.2,
          hp: 2000,
          maxHp: 2000,
          energy: 0,
          ultimateNonce: 0,
          role: p2.selectedRole,
          rootTimer: 0,
        },
      ];

      room.gameState.stats = {
        p1: { totalDamageDealt: 0, totalDamageTaken: 0, totalHealing: 0 },
        p2: { totalDamageDealt: 0, totalDamageTaken: 0, totalHealing: 0 },
      };

      // 將玩家的 rematch 狀態歸零，為下一局做準備
      room.players.forEach((p) => (p.rematchReady = false));
      room.phase = "battle";

      // 通知雙方：「共識達成，重新開戰！」
      io.to(roomId).emit("rematchConfirmed");
    } else {
      // 只有單方同意，通知另一方「對手想再來一局」
      io.to(roomId).emit("rematchRequested", { side: me.side });
    }
  });

  // 🟢 接收前端的回報，並加入 energyGain 參數來動態給予能量
  socket.on(
    "takeDamage",
    ({ roomId, targetId, attackerId, damage, hitType, playerKey }) => {
      const room = rooms.get(roomId);
      if (!room || room.phase !== "battle" || !room.gameState) return;
      const me = getOwnedPlayer(room, socket, playerKey);
      if (!me || attackerId !== me.side || targetId === me.side) return;
      const rule = validateReportedHit(room, attackerId, targetId, damage, hitType);
      if (!rule) return;
      applyServerDamage(roomId, targetId, attackerId, damage, rule.energy);
    },
  );

  // 🟢 接收前端的分身死亡回收能量回報
  socket.on("addEnergy", ({ roomId, targetId, amount, playerKey }) => {
    const room = rooms.get(roomId);
    const me = room && getOwnedPlayer(room, socket, playerKey);
    if (!room || room.phase !== "battle" || !me || targetId !== me.side) return;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10) return;
    if (!consumeRateLimit(room, `${me.side}:energy`, 5, 60)) return;
    addServerEnergy(roomId, targetId, amount);
  });

  socket.on("healHp", ({ roomId, targetId, amount, playerKey }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "battle" || !room.gameState) return;
    const me = getOwnedPlayer(room, socket, playerKey);
    if (!me || targetId !== me.side || !Number.isFinite(amount)) return;
    if (!consumeRateLimit(room, `${me.side}:heal`, 1, 90)) return;
    const targetBall = room.gameState.balls.find((b) => b.id === targetId);
    if (targetBall) {
      const safeAmount = Math.max(0, Math.min(150, amount));
      targetBall.hp = Math.min(targetBall.maxHp, targetBall.hp + safeAmount);
      if (room.gameState.stats[targetId])
        room.gameState.stats[targetId].totalHealing += safeAmount;
    }
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    for (const [roomId, room] of rooms.entries()) {
      const leavingPlayer = room.players.find((p) => p.socketId === socket.id);
      if (!leavingPlayer) continue;
      leavingPlayer.connected = false;
      emitRoomState(roomId);
      const timerKey = `${roomId}:${leavingPlayer.playerKey}`;
      const timer = setTimeout(() => {
        const latestRoom = rooms.get(roomId);
        if (!latestRoom) return;
        const latestPlayer = latestRoom.players.find(
          (p) => p.playerKey === leavingPlayer.playerKey,
        );
        if (!latestPlayer || !latestPlayer.connected) {
          socket
            .to(roomId)
            .emit("enemyLeft", { message: "對手已離線", roomId });
        }
        disconnectTimers.delete(timerKey);
      }, 4000);
      disconnectTimers.set(timerKey, timer);
      scheduleRoomCleanup(roomId);
    }
  });
});

let lastPhysicsTickAt = Date.now();
let lastPhysicsTickMs = 1000 / 60;

// 伺服器端物理核心迴圈
setInterval(() => {
  const physicsTickNow = Date.now();
  lastPhysicsTickMs = physicsTickNow - lastPhysicsTickAt;
  lastPhysicsTickAt = physicsTickNow;
  for (const [roomId, room] of rooms.entries()) {
    if (room.phase !== "battle" || !room.gameState) continue;

    if (room.gameState.openingFrames < 240) {
      room.gameState.openingFrames++;
        io.to(roomId).emit("updateGameState", {
          opening: true,
          balls: room.gameState.balls,
          stats: room.gameState.stats,
          serverTickMs: lastPhysicsTickMs,
      });
      continue;
    }

    room.gameState.frame++;
    const balls = room.gameState.balls;
    const b1 = balls[0],
      b2 = balls[1];

    // 1. 更新黑洞計時器
    if (room.gameState.blackHole && room.gameState.blackHole.active) {
      room.gameState.blackHole.timer--;
      if (room.gameState.blackHole.timer <= 0)
        room.gameState.blackHole.active = false;
    }

    balls.forEach((ball) => {
      // 🟢 熔岩巨獸：大招 2.5 秒倒數與極速擊退觸發
      if (ball.magmaUltTimer !== undefined && ball.magmaUltTimer > 0) {
        ball.magmaUltTimer--;
        if (ball.magmaUltTimer <= 0) {
          const attacker = room.gameState.balls.find(
            (b) => b.id === ball.magmaAttackerId,
          );
          if (attacker) {
            const dx = ball.x - attacker.x;
            const dy = ball.y - attacker.y;
            const dist = Math.hypot(dx, dy) || 1;

            // 炸飛對手
            ball.vx = (dx / dist) * 50;
            ball.vy = (dy / dist) * 50;
            ball.rootTimer = 0; // 提早解除禁錮

            // 🟢 爆炸結束，解除熔岩巨獸的施法狀態，並給他一個帥氣的反作用力後退！
            const targetSpeed = attacker.baseSpeed || 12.2;
            attacker.vx = -(dx / dist) * targetSpeed;
            attacker.vy = -(dy / dist) * targetSpeed;

            // 啟動對手的衰減
            ball.magmaDecayStage = 1;
            ball.magmaDecayTimer = 30; // 0.5 秒後觸發第一次衰減
          }
        }
      }

      // 🟢 熔岩巨獸：擊退速度每 0.5 秒減半的衰減邏輯
      if (ball.magmaDecayStage > 0) {
        ball.magmaDecayTimer--;
        if (ball.magmaDecayTimer <= 0) {
          const currentSpeed = Math.hypot(ball.vx, ball.vy);
          if (currentSpeed > 0.001) {
            ball.vx = (ball.vx / currentSpeed) * (currentSpeed / 2);
            ball.vy = (ball.vy / currentSpeed) * (currentSpeed / 2);
          }

          ball.magmaDecayStage++;
          ball.magmaDecayTimer = 30;

          if (ball.magmaDecayStage >= 4) {
            ball.magmaDecayStage = 0;
            const targetSpeed = ball.baseSpeed || 12.2;
            const finalSpeed = Math.hypot(ball.vx, ball.vy) || 1;
            ball.vx = (ball.vx / finalSpeed) * targetSpeed;
            ball.vy = (ball.vy / finalSpeed) * targetSpeed;
          }
        }
      }

      // 2. 🌠 Nova 引力與黑洞物理
      const enemy = room.gameState.balls.find((b) => b.id !== ball.id);
      if (enemy && (!ball.rootTimer || ball.rootTimer <= 0)) {
        if (enemy.role === "nova") {
          const dx = enemy.x - ball.x,
            dy = enemy.y - ball.y;
          const dist = Math.hypot(dx, dy) || 1;
          if (dist < 250) {
            ball.x += (dx / dist) * 3.5;
            ball.y += (dy / dist) * 3.5;
          }
        }
        const bh = room.gameState.blackHole;
        if (bh && bh.active && bh.ownerTag !== ball.id) {
          const dx = bh.x - ball.x,
            dy = bh.y - ball.y;
          const dist = Math.hypot(dx, dy) || 1;
          ball.x += (dx / dist) * 3.5;
          ball.y += (dy / dist) * 3.5;
        }
      }

      // 3. 禁錮與邊界碰撞
      if (ball.rootTimer && ball.rootTimer > 0) {
        ball.rootTimer--;
      } else {
        ball.x += ball.vx;
        ball.y += ball.vy;
        if (ball.x - BALL_RADIUS <= 0) {
          ball.x = BALL_RADIUS;
          ball.vx = Math.abs(ball.vx);
        }
        if (ball.x + BALL_RADIUS >= ARENA_SIZE) {
          ball.x = ARENA_SIZE - BALL_RADIUS;
          ball.vx = -Math.abs(ball.vx);
        }
        if (ball.y - BALL_RADIUS <= 0) {
          ball.y = BALL_RADIUS;
          ball.vy = Math.abs(ball.vy);
        }
        if (ball.y + BALL_RADIUS >= ARENA_SIZE) {
          ball.y = ARENA_SIZE - BALL_RADIUS;
          ball.vy = -Math.abs(ball.vy);
        }
      }
    }); // 👈 確保 forEach 完美閉合

    updateServerEffects(roomId, room);
    if (room.phase !== "battle") continue;

    // --- 主球碰撞結算 ---
    const dx = b2.x - b1.x,
      dy = b2.y - b1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = BALL_RADIUS * 2;

    let bodyCollisionEvent = false;
    if (dist < minDist && dist > 0) {
      const lastCol = room.gameState.lastCollisionFrame || -100;
      if (room.gameState.frame - lastCol >= 10) {
        room.gameState.lastCollisionFrame = room.gameState.frame;
        // 碰撞回能與傷害分開：影分身本體雖然不造成碰撞傷害，仍應獲得碰撞能量。
        applyServerDamage(roomId, "p2", "p1", getBodyDamage(b1));
        applyServerDamage(roomId, "p1", "p2", getBodyDamage(b2));
        addServerEnergy(roomId, "p1", 10);
        addServerEnergy(roomId, "p2", 10);
        bodyCollisionEvent = true;
      }

      const overlap = (minDist - dist) / 2;
      const nx = dx / dist,
        ny = dy / dist;

      if (!b1.rootTimer || b1.rootTimer <= 0) {
        b1.x -= nx * overlap;
        b1.y -= ny * overlap;
      }
      if (!b2.rootTimer || b2.rootTimer <= 0) {
        b2.x += nx * overlap;
        b2.y += ny * overlap;
      }

      const velAlongNormal = (b1.vx - b2.vx) * nx + (b1.vy - b2.vy) * ny;
      if (velAlongNormal > 0) {
        const tx = -ny,
          ty = nx;
        const aNorm = b1.vx * nx + b1.vy * ny,
          aTan = b1.vx * tx + b1.vy * ty;
        const bNorm = b2.vx * nx + b2.vy * ny,
          bTan = b2.vx * tx + b2.vy * ty;

        b1.vx = bNorm * nx + aTan * tx;
        b1.vy = bNorm * ny + aTan * ty;
        b2.vx = aNorm * nx + bTan * tx;
        b2.vy = aNorm * ny + bTan * ty;

        const fixSpeed = (ball) => {
          // 🟢 關鍵修復：如果正處於擊飛極速狀態，不要把速度強制縮回 12.2！
          if (ball.magmaDecayStage > 0) return;

          const currentSpeed = Math.hypot(ball.vx, ball.vy);
          const targetSpeed = 12.2;
          if (currentSpeed > 0.001) {
            ball.vx = (ball.vx / currentSpeed) * targetSpeed;
            ball.vy = (ball.vy / currentSpeed) * targetSpeed;
          }
        };

        if (!b1.rootTimer || b1.rootTimer <= 0) fixSpeed(b1);
        if (!b2.rootTimer || b2.rootTimer <= 0) fixSpeed(b2);
      }
    }

    if (bodyCollisionEvent) {
      io.to(roomId).emit("bodyCollision", {
        balls: balls.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy })),
      });
    }

    const stateUpdate = {
      frame: room.gameState.frame,
      balls: balls,
      stats: room.gameState.stats,
      serverTickMs: lastPhysicsTickMs,
    };
    // 球體位置每幀同步，確保畫面與碰撞判定一致；較大的環境特效才降頻傳送。
    if (room.gameState.frame % EFFECTS_BROADCAST_INTERVAL === 0) {
      stateUpdate.magmaPools = room.gameState.magmaPools;
      stateUpdate.colosseum = room.gameState.colosseum;
      stateUpdate.blackHole = room.gameState.blackHole;
    }
    io.to(roomId).emit("updateGameState", stateUpdate);
  }
}, 1000 / 60);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`伺服器啟動：http://localhost:${PORT}`);
});
