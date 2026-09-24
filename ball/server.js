const express = require("express");
const Dawn = require('./public/dawn.js');
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
const BALL_RADIUS = 100;
const BODY_DAMAGE = 50;
const MAGMA_POOL_LIFETIME = 210;
const MAGMA_POOL_DAMAGE = 12;
const MAGMA_POOL_DAMAGE_INTERVAL = 30;
const MAGMA_BODY_DAMAGE = 35;
const MAGMA_STACK_BONUS_DAMAGE = 5;
const MAGMA_MAX_STACKS = 5;
const MAGMA_STACK_DURATION = 240;
const MAGMA_SLOW_PER_STACK = 0.06;
const ARENA_DAMAGE = 12;
const ARENA_DAMAGE_INTERVAL = 30;
const JOKER_MAX_HP = 1850;
const JOKER_BASE_SPEED = 11.5;
const JOKER_BODY_DAMAGE = 30;
const JOKER_CARD_LIFETIME = 180;
const JOKER_CARD_ARM_DELAY = 18;
const JOKER_CARD_RADIUS = 28;
const JOKER_CARD_DAMAGE = 30;
const JOKER_ULTIMATE_CARD_DAMAGE = 38;
const JOKER_PASSIVE_CARD_COUNT = 3;
const JOKER_ULTIMATE_CARD_COUNT = 5;
const JOKER_SHOW_DURATION = 180;
const EFFECTS_BROADCAST_INTERVAL = 3;
const STALE_COMBAT_FRAMES = 900;
const FRENZY_REFLECT_RATIO = 0.02;
const FRENZY_HIT_ENERGY = 3;
const FRENZY_HIT_ENERGY_COOLDOWN = 30;
const FRENZY_ULTIMATE_DURATION = 120;
const FRENZY_ULTIMATE_SPEED = 28;
const FRENZY_ULTIMATE_DAMAGE_REDUCE = 0.25;
// 暴走續航只由有效的主球碰撞觸發；由伺服器結算，避免線上前端不同步。
const FRENZY_ULTIMATE_HEAL_LOST_HP_RATIO = 0.30;
const MAGMA_MAX_HP = 2400;
const MAGMA_BASE_SPEED = 9.2;
const ALLOWED_ROLES = new Set(["speeder", "tank", "frenzy", "magma", "nova", "clone", "dawn"]);
const MAX_NAME_LENGTH = 24;
const MAX_IMAGE_DATA_LENGTH = 300_000;
const HIT_RULES = {
  clone: { role: "clone", maxDamage: 5, energy: 0, cooldown: 10 },
  sword: { role: "frenzy", maxDamage: 20, energy: 10, cooldown: 90, range: 250 },
  magma: { role: "magma", maxDamage: 10, energy: 1, cooldown: 30, range: 210 },
  arena: { role: "magma", maxDamage: 50, energy: 1, cooldown: 30, range: 230 },
  missile: { role: "clone", maxDamage: 25, energy: 10, cooldown: 120 },
  bigMissile: { role: "clone", maxDamage: 500, energy: 0, cooldown: 480 },
};

function cleanName(value) {
  return String(value || "玩家").trim().slice(0, MAX_NAME_LENGTH) || "玩家";
}

function getServerBaseSpeed(role) {
  if (role === 'dawn') return 10.5;
  if (role === "magma") return MAGMA_BASE_SPEED;
  if (role === "nova") return JOKER_BASE_SPEED;
  return 12.2;
}

function getServerMaxHp(role) {
  if (role === 'dawn') return 2200;
  if (role === "magma") return MAGMA_MAX_HP;
  if (role === "nova") return JOKER_MAX_HP;
  return 2000;
}

function resetBattlePositions(state) {
  const p1 = state.balls.find((ball) => ball.id === "p1");
  const p2 = state.balls.find((ball) => ball.id === "p2");
  if (!p1 || !p2) return;
  p1.x = 175; p1.y = 575;
  p1.vx = p1.baseSpeed * 10 / 12.2; p1.vy = p1.baseSpeed * -7 / 12.2;
  p2.x = 575; p2.y = 175;
  p2.vx = p2.baseSpeed * -10 / 12.2; p2.vy = p2.baseSpeed * 7 / 12.2;
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
  if (ball.role === 'dawn') { Dawn.energy(ball, amount); return; }
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
        const centerX = (ball.x + enemy.x) / 2;
        const centerY = (ball.y + enemy.y) / 2;
        const radius = Math.min(330, Math.max(240, Math.hypot(enemy.x - ball.x, enemy.y - ball.y) / 2 + BALL_RADIUS + 20));
        room.gameState.colosseum = {
          active: true,
          timer: 180,
          x: centerX,
          y: centerY,
          radius,
          ownerTag: ballId,
          nextDamageFrame: room.gameState.frame,
        };

        io.to(roomId).emit("triggerUltimate", {
          playerId: ballId,
          role: "magma",
          targetX: centerX,
          targetY: centerY,
          radius,
        });
      }
    } else if (ball.role === "nova") {
      const enemy = room.gameState.balls.find((candidate) => candidate.id !== ballId);
      if (!enemy) return;
      ball.jokerShowTimer = JOKER_SHOW_DURATION;
      spawnJokerHand(room.gameState, ball, enemy, true);
      io.to(roomId).emit("triggerUltimate", {
        playerId: ballId,
        role: "nova",
      });
    } else if (ball.role === "frenzy") {
      ball.ultimateNonce = (ball.ultimateNonce || 0) + 1;
      ball.frenzyUltimateTimer = FRENZY_ULTIMATE_DURATION;
      const currentSpeed = Math.hypot(ball.vx, ball.vy) || 1;
      ball.vx = (ball.vx / currentSpeed) * FRENZY_ULTIMATE_SPEED;
      ball.vy = (ball.vy / currentSpeed) * FRENZY_ULTIMATE_SPEED;
      io.to(roomId).emit("triggerUltimate", {
        playerId: ballId,
        role: "frenzy",
        ultimateNonce: ball.ultimateNonce,
      });
    } else {
      // 其他尚未實作大招的角色滿能量後僅重置能量，不能假裝有大招效果。
    }
  } // 結束 if (ball.energy >= 100)
} // 結束 function addServerEnergy

function applyServerDamage(roomId, targetId, attackerId, damage, energyGain = 0) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== "battle" || !room.gameState) return;
  const safeDamage = Math.max(0, Math.min(500, Number(damage) || 0));
  const safeEnergyGain = Math.max(0, Math.min(10, Number(energyGain) || 0));
  if (safeDamage <= 0) return;
  room.gameState.lastCombatFrame = room.gameState.frame;

  const targetBall = room.gameState.balls.find((ball) => ball.id === targetId);
  const attackerBall = room.gameState.balls.find((ball) => ball.id === attackerId);
  if (!targetBall || !attackerBall || targetId === attackerId) return;

  const frenzyReduction = targetBall.role === "frenzy" && targetBall.frenzyUltimateTimer > 0
    ? FRENZY_ULTIMATE_DAMAGE_REDUCE
    : 0;
  let appliedDamage = Math.max(0, Math.round(safeDamage * (1 - frenzyReduction)));
  if (targetBall.role === 'dawn') appliedDamage = Dawn.damage(targetBall, appliedDamage);
  targetBall.hp = Math.max(0, targetBall.hp - appliedDamage);
  room.gameState.stats[targetId].totalDamageTaken += appliedDamage;
  room.gameState.stats[attackerId].totalDamageDealt += appliedDamage;
  if (safeEnergyGain > 0) addServerEnergy(roomId, attackerId, safeEnergyGain);

  // 先確認本次正常傷害造成的死亡；死亡後不觸發受擊型被動。
  if (targetBall.hp <= 0) {
    finishBattle(roomId, attackerId, targetId);
    return;
  }
  if (targetBall.role === 'dawn') Dawn.energy(targetBall, appliedDamage / 20);

  // 狂暴的常駐被動：活著承受一次有效傷害時，回能並反射該次傷害的 2%。
  // 直接結算反傷，避免兩名狂暴互相反射造成遞迴傷害。
  if (targetBall.role === "frenzy" && targetBall.hp > 0 && room.phase === "battle") {
    if (room.gameState.frame >= (targetBall.frenzyEnergyUntil || 0)) {
      targetBall.frenzyEnergyUntil = room.gameState.frame + FRENZY_HIT_ENERGY_COOLDOWN;
      addServerEnergy(roomId, targetId, FRENZY_HIT_ENERGY);
    }
    const reflectDamage = attackerBall.role === 'dawn' ? Dawn.damage(attackerBall, appliedDamage * FRENZY_REFLECT_RATIO, true) : appliedDamage * FRENZY_REFLECT_RATIO;
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

function healServerBall(roomId, ballId, amount) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== "battle" || !room.gameState) return 0;
  const ball = room.gameState.balls.find((candidate) => candidate.id === ballId);
  if (!ball) return 0;
  const safeAmount = Math.max(0, Math.min(150, Number(amount) || 0));
  const before = ball.hp;
  ball.hp = Math.min(ball.maxHp, ball.hp + safeAmount);
  const applied = ball.hp - before;
  if (applied > 0 && room.gameState.stats[ballId]) {
    room.gameState.stats[ballId].totalHealing += applied;
  }
  return applied;
}

function healFrenzyUltimateOnBodyCollision(roomId, ballId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== "battle" || !room.gameState) return 0;
  const ball = room.gameState.balls.find((candidate) => candidate.id === ballId);
  if (!ball || ball.role !== "frenzy" || ball.hp <= 0 || ball.frenzyUltimateTimer <= 0) return 0;
  const lostHp = Math.max(0, ball.maxHp - ball.hp);
  return healServerBall(roomId, ballId, lostHp * FRENZY_ULTIMATE_HEAL_LOST_HP_RATIO);
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

function getBodyDamage(ball, target) {
  if (ball.role === 'dawn') return Dawn.body(ball);
  if (ball.role === "clone") return 0;
  if (ball.role === "magma") return MAGMA_BODY_DAMAGE + Math.min(MAGMA_MAX_STACKS, target?.magmaStacks || 0) * MAGMA_STACK_BONUS_DAMAGE;
  if (ball.role === "nova") return JOKER_BODY_DAMAGE;
  return BODY_DAMAGE;
}

function spawnJokerCard(state, ownerTag, x, y, damage, isUltimate, isReal, effect) {
  state.jokerCards ||= [];
  const safeX = Math.max(BALL_RADIUS, Math.min(ARENA_SIZE - BALL_RADIUS, x));
  const safeY = Math.max(BALL_RADIUS, Math.min(ARENA_SIZE - BALL_RADIUS, y));
  state.jokerCards.push({
    x: safeX, y: safeY, ownerTag, damage,
    isUltimate, isReal, effect, life: JOKER_CARD_LIFETIME,
    armedAt: state.frame + JOKER_CARD_ARM_DELAY,
  });
}

function spawnJokerHand(state, owner, target, isUltimate = false) {
  state.jokerCards ||= [];
  // 一次只保留一組被動蓋牌；這是佈局，不是把賽場塞滿地雷。
  if (!isUltimate) state.jokerCards = state.jokerCards.filter((card) => card.ownerTag !== owner.id || card.isUltimate);
  const count = isUltimate ? JOKER_ULTIMATE_CARD_COUNT : JOKER_PASSIVE_CARD_COUNT;
  const realIndexes = isUltimate
    ? [state.jokerTrickIndex % count, (state.jokerTrickIndex + 2) % count]
    : [state.jokerTrickIndex % count];
  const direction = Math.atan2(target.vy, target.vx);
  for (let index = 0; index < count; index++) {
    const spread = count === 1 ? 0 : (index / (count - 1) - 0.5) * (isUltimate ? 2.6 : 1.9);
    const angle = direction + spread;
    const distance = isUltimate ? 165 : 135;
    const isReal = realIndexes.includes(index);
    const effect = isReal && (state.jokerTrickIndex + index) % 2 === 1 ? "swap" : "turn";
    spawnJokerCard(state, owner.id, target.x + Math.cos(angle) * distance, target.y + Math.sin(angle) * distance, isUltimate ? JOKER_ULTIMATE_CARD_DAMAGE : JOKER_CARD_DAMAGE, isUltimate, isReal, effect);
  }
  state.jokerTrickIndex = (state.jokerTrickIndex || 0) + 1;
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
    if (state.frame > (target.magmaStacksUntil || 0)) target.magmaStacks = 0;
    const pool = state.magmaPools.find((candidate) =>
      candidate.ownerTag !== target.id &&
      Math.hypot(target.x - candidate.x, target.y - candidate.y) <= BALL_RADIUS + 48,
    );
    if (!pool || state.frame < (target.magmaBurnUntil || 0)) continue;
    target.magmaBurnUntil = state.frame + MAGMA_POOL_DAMAGE_INTERVAL;
    target.magmaStacks = Math.min(MAGMA_MAX_STACKS, (target.magmaStacks || 0) + 1);
    target.magmaStacksUntil = state.frame + MAGMA_STACK_DURATION;
    const burnDamage = MAGMA_POOL_DAMAGE + (target.magmaStacks - 1) * 2;
    applyServerDamage(roomId, target.id, pool.ownerTag, burnDamage, 1);
  }

  for (const target of balls) {
    const stacks = Math.min(MAGMA_MAX_STACKS, target.magmaStacks || 0);
    if (!stacks && !target.magmaSlowApplied) continue;
    const currentSpeed = Math.hypot(target.vx, target.vy) || 1;
    const baseSpeed = target.dawnUlt > 0 ? 14 : target.frenzyUltimateTimer > 0 ? FRENZY_ULTIMATE_SPEED : (target.baseSpeed || 12.2);
    const desiredSpeed = baseSpeed * (1 - stacks * MAGMA_SLOW_PER_STACK);
    target.vx = (target.vx / currentSpeed) * desiredSpeed;
    target.vy = (target.vy / currentSpeed) * desiredSpeed;
    target.magmaSlowApplied = stacks > 0;
  }

  const arena = state.colosseum;
  if (arena?.active) {
    arena.timer--;
    // 火山封鎖是實體邊界，不是純視覺圓圈；兩人都只能在環內反彈。
    for (const ball of balls) {
      const dx = ball.x - arena.x, dy = ball.y - arena.y;
      const distance = Math.hypot(dx, dy) || 1;
      const limit = Math.max(BALL_RADIUS, arena.radius - BALL_RADIUS);
      if (distance <= limit) continue;
      const nx = dx / distance, ny = dy / distance;
      ball.x = arena.x + nx * limit;
      ball.y = arena.y + ny * limit;
      const outwardSpeed = ball.vx * nx + ball.vy * ny;
      if (outwardSpeed > 0) {
        ball.vx -= 2 * outwardSpeed * nx;
        ball.vy -= 2 * outwardSpeed * ny;
      }
    }
    if (arena.timer <= 0) {
      arena.active = false;
      const target = balls.find((ball) => ball.id !== arena.ownerTag);
      if (target && target.magmaStacks > 0) {
        applyServerDamage(roomId, target.id, arena.ownerTag, target.magmaStacks * 20, 0);
        target.magmaStacks = 0;
      }
    }
    else if (state.frame >= arena.nextDamageFrame) {
      const target = balls.find((ball) => ball.id !== arena.ownerTag);
      if (target && Math.hypot(target.x - arena.x, target.y - arena.y) < arena.radius) {
        if (target.magmaStacks > 0) target.magmaStacksUntil = state.frame + 1;
        applyServerDamage(roomId, target.id, arena.ownerTag, ARENA_DAMAGE, 1);
      }
      arena.nextDamageFrame = state.frame + ARENA_DAMAGE_INTERVAL;
    }
  }

  for (let index = state.jokerCards.length - 1; index >= 0; index--) {
    const card = state.jokerCards[index];
    card.life--;
    if (card.life <= 0) {
      state.jokerCards.splice(index, 1);
      continue;
    }
    if (state.frame < card.armedAt) continue;
    const target = balls.find((ball) => ball.id !== card.ownerTag);
    if (!target || Math.hypot(target.x - card.x, target.y - card.y) > BALL_RADIUS + JOKER_CARD_RADIUS) continue;
    if (card.isReal) {
      applyServerDamage(roomId, target.id, card.ownerTag, card.damage, 2);
      if (room.phase !== "battle") return;
      const owner = balls.find((ball) => ball.id === card.ownerTag);
      if (card.effect === "swap" && owner) {
        const ownerX = owner.x, ownerY = owner.y;
        owner.x = target.x; owner.y = target.y;
        target.x = ownerX; target.y = ownerY;
      } else {
        // 轉向而不加速、不定身，效果強但不會製造物理卡頓。
        const vx = target.vx, vy = target.vy;
        target.vx = -vy;
        target.vy = vx;
      }
    }
    state.jokerCards.splice(index, 1);
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
      lastCombatFrame: 0,
      hitCooldowns: {},
      rateLimits: {},
      magmaPools: [],
      colosseum: null,
      jokerCards: [],
      jokerTrickIndex: 0,
      openingFrames: 0, // 🟢 新增：進場動畫計時器
      balls: [
        // 🟢 加入 baseSpeed: 12.2 (這是 10 和 -7 向量算出來的預設總速度)
        {
          id: "p1",
          x: 175,
          y: 575,
          vx: getServerBaseSpeed(p1.selectedRole) * 10 / 12.2,
          vy: getServerBaseSpeed(p1.selectedRole) * -7 / 12.2,
          baseSpeed: getServerBaseSpeed(p1.selectedRole),
          hp: getServerMaxHp(p1.selectedRole),
          maxHp: getServerMaxHp(p1.selectedRole),
          energy: 0,
          ultimateNonce: 0,
          role: p1.selectedRole,
          rootTimer: 0,
          frenzyUltimateTimer: 0,
        },
        {
          id: "p2",
          x: 575,
          y: 175,
          vx: getServerBaseSpeed(p2.selectedRole) * -10 / 12.2,
          vy: getServerBaseSpeed(p2.selectedRole) * 7 / 12.2,
          baseSpeed: getServerBaseSpeed(p2.selectedRole),
          hp: getServerMaxHp(p2.selectedRole),
          maxHp: getServerMaxHp(p2.selectedRole),
          energy: 0,
          ultimateNonce: 0,
          role: p2.selectedRole,
          rootTimer: 0,
          frenzyUltimateTimer: 0,
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
      room.gameState.lastCombatFrame = 0;
      room.gameState.openingFrames = 0;
      room.gameState.lastCollisionFrame = 0;
      room.gameState.hitCooldowns = {};
      room.gameState.rateLimits = {};
      room.gameState.jokerCards = [];
      room.gameState.jokerTrickIndex = 0;
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
          vx: getServerBaseSpeed(p1.selectedRole) * 10 / 12.2,
          vy: getServerBaseSpeed(p1.selectedRole) * -7 / 12.2,
          baseSpeed: getServerBaseSpeed(p1.selectedRole),
          hp: getServerMaxHp(p1.selectedRole),
          maxHp: getServerMaxHp(p1.selectedRole),
          energy: 0,
          ultimateNonce: 0,
          role: p1.selectedRole,
          rootTimer: 0,
          frenzyUltimateTimer: 0,
        },
        {
          id: "p2",
          x: 575,
          y: 175,
          vx: getServerBaseSpeed(p2.selectedRole) * -10 / 12.2,
          vy: getServerBaseSpeed(p2.selectedRole) * 7 / 12.2,
          baseSpeed: getServerBaseSpeed(p2.selectedRole),
          hp: getServerMaxHp(p2.selectedRole),
          maxHp: getServerMaxHp(p2.selectedRole),
          energy: 0,
          ultimateNonce: 0,
          role: p2.selectedRole,
          rootTimer: 0,
          frenzyUltimateTimer: 0,
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
    healServerBall(roomId, targetId, amount);
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

    if (room.gameState.frame - (room.gameState.lastCombatFrame || 0) >= STALE_COMBAT_FRAMES) {
      resetBattlePositions(room.gameState);
      room.gameState.lastCombatFrame = room.gameState.frame;
      io.to(roomId).emit("battleRepositioned");
    }

    balls.forEach((ball) => {
      if (ball.role === 'dawn') Dawn.tick(ball);
      if (ball.jokerShowTimer > 0) ball.jokerShowTimer--;
      // 狂暴大招必須在伺服器維護，否則每幀位置同步會覆蓋前端的速度效果。
      if (ball.frenzyUltimateTimer > 0) {
        ball.frenzyUltimateTimer--;
        if (ball.frenzyUltimateTimer <= 0) {
          const currentSpeed = Math.hypot(ball.vx, ball.vy) || 1;
          const normalSpeed = ball.baseSpeed || 12.2;
          ball.vx = (ball.vx / currentSpeed) * normalSpeed;
          ball.vy = (ball.vy / currentSpeed) * normalSpeed;
        }
      }

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

      // 2. 禁錮與邊界碰撞
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
      room.gameState.lastCombatFrame = room.gameState.frame;
      const lastCol = room.gameState.lastCollisionFrame || -100;
      if (room.gameState.frame - lastCol >= 10) {
        room.gameState.lastCollisionFrame = room.gameState.frame;
        // 碰撞回能與傷害分開：影分身本體雖然不造成碰撞傷害，仍應獲得碰撞能量。
        applyServerDamage(roomId, "p2", "p1", getBodyDamage(b1, b2));
        applyServerDamage(roomId, "p1", "p2", getBodyDamage(b2, b1));
        // 狂暴暴走的回血只認主球有效碰撞，不認劍砍、飛彈或其他傷害來源。
        healFrenzyUltimateOnBodyCollision(roomId, "p1");
        healFrenzyUltimateOnBodyCollision(roomId, "p2");
        // 鬼牌小丑的被動：一組蓋牌只藏一張真牌；同撞瞬間不會偷吃傷害。
        if (b1.role === "nova") spawnJokerHand(room.gameState, b1, b2);
        if (b2.role === "nova") spawnJokerHand(room.gameState, b2, b1);
        if (b1.role === "magma") b2.magmaStacks = Math.max(0, (b2.magmaStacks || 0) - 2);
        if (b2.role === "magma") b1.magmaStacks = Math.max(0, (b1.magmaStacks || 0) - 2);
        if (b1.role !== 'dawn' || b1.dawnBodyCd === 12) addServerEnergy(roomId, "p1", 10);
        if (b2.role !== 'dawn' || b2.dawnBodyCd === 12) addServerEnergy(roomId, "p2", 10);
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
          const targetSpeed = ball.dawnUlt > 0 ? 14 : ball.frenzyUltimateTimer > 0 ? FRENZY_ULTIMATE_SPEED : (ball.baseSpeed || 12.2);
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
      stateUpdate.jokerCards = room.gameState.jokerCards;
    }
    io.to(roomId).emit("updateGameState", stateUpdate);
  }
}, 1000 / 60);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`伺服器啟動：http://localhost:${PORT}`);
});
