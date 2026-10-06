const test = require('node:test');
const assert = require('node:assert/strict');
const GameConfig = require('../public/game-config.js');

test('every playable hero has valid shared base stats', () => {
  assert.equal(GameConfig.roleIds.length, 7);
  assert.equal(new Set(GameConfig.roleIds).size, GameConfig.roleIds.length);
  for (const roleId of GameConfig.roleIds) {
    const role = GameConfig.roles[roleId];
    assert.ok(role, `${roleId} has a definition`);
    assert.ok(Number.isFinite(role.hp) && role.hp > 0, `${roleId} hp`);
    assert.ok(Number.isFinite(role.speed) && role.speed > 0, `${roleId} speed`);
    assert.ok(Number.isFinite(role.radius) && role.radius > 0, `${roleId} radius`);
    assert.equal(typeof role.skill, 'string', `${roleId} skill`);
    assert.ok(Object.isFrozen(role), `${roleId} is immutable`);
  }
});

test('published balance baselines remain explicit', () => {
  assert.deepEqual(
    GameConfig.roleIds.map(id => [id, GameConfig.roles[id].hp, GameConfig.roles[id].speed]),
    [
      ['dawn', 2200, 10.5],
      ['speeder', 2000, 12.2],
      ['tank', 2000, 12.2],
      ['frenzy', 2000, 12.2],
      ['magma', 2400, 9.2],
      ['nova', 1850, 11.5],
      ['clone', 2000, 12.2],
    ]
  );
});
