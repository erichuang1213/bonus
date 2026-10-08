const test = require('node:test');
const assert = require('node:assert/strict');

class FakeImage {
  constructor() { this.complete = true; this.naturalWidth = 512; }
  set src(value) { this.source = value; }
  get src() { return this.source; }
}

global.Image = FakeImage;
const HeroCinematics = require('../public/hero-cinematics.js');

test('Frenzy assets load only when selected, and an ultimate queues once', () => {
  const cinematics = new HeroCinematics();
  assert.equal(cinematics.frenzyAwakened, null);
  cinematics.prepare(['tank']);
  assert.equal(cinematics.frenzyAwakened, null);
  cinematics.prepare(['frenzy']);
  assert.match(cinematics.frenzyAwakened.src, /frenzy-awakened\.webp$/);
  const firstAwakened = cinematics.frenzyAwakened;
  cinematics.prepare(['frenzy']);
  assert.equal(cinematics.frenzyAwakened, firstAwakened);

  const ball = { playerTag: 'p1', roleId: 'frenzy', ballImageObj: new FakeImage(), usesCustomImage: false };
  cinematics.playFrenzy(ball);
  cinematics.playFrenzy(ball);
  assert.equal(cinematics.active.type, 'frenzy');
  assert.equal(cinematics.queue.length, 0);
  assert.equal(cinematics.getFrenzyAwakenedImage(ball), cinematics.frenzyAwakened);
  ball.usesCustomImage = true;
  assert.equal(cinematics.getFrenzyAwakenedImage(ball), null);
  cinematics.reset();
  assert.equal(cinematics.active, null);
});

test('Frenzy armor stays closed at rest and draws four moving plates during ultimate', () => {
  const cinematics = new HeroCinematics();
  const calls = [];
  const ctx = {
    globalAlpha: 1,
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    translate(x, y) { calls.push(['translate', x, y]); },
    rotate(angle) { calls.push(['rotate', angle]); },
    beginPath() {}, arc() {}, closePath() {}, clip() {},
    drawImage() { calls.push('drawImage'); },
  };
  const image = new FakeImage();

  cinematics.drawFrenzyArmorPlates(ctx, image, 100, 100, 50, 0);
  assert.equal(calls.length, 0);
  cinematics.drawFrenzyArmorPlates(ctx, image, 100, 100, 50, 1);
  assert.equal(calls.filter(call => call === 'drawImage').length, 4);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'translate').length, 4);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'translate' && call[1] !== 100 && call[2] !== 100));
  const fullOffset = Math.hypot(calls[2][1] - 100, calls[2][2] - 100);
  calls.length = 0;
  cinematics.drawFrenzyArmorPlates(ctx, image, 100, 100, 50, 0.55);
  const halfOpenOffset = Math.hypot(calls[2][1] - 100, calls[2][2] - 100);
  assert.ok(halfOpenOffset > 0 && halfOpenOffset < fullOffset);
});

test('Frenzy keeps a distinct half-open look after the ultimate ends', () => {
  const cinematics = new HeroCinematics();
  const ball = { ultimateTimer: 0, frenzyAwakenedLook: false };
  assert.equal(cinematics.getFrenzyVisualTarget(ball), 0);
  ball.ultimateTimer = 120;
  ball.frenzyAwakenedLook = true;
  assert.equal(cinematics.getFrenzyVisualTarget(ball), 1);
  ball.ultimateTimer = 0;
  assert.equal(cinematics.getFrenzyVisualTarget(ball), 0.55);
});
