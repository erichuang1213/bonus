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
  assert.equal(cinematics.frenzyBlade, null);
  cinematics.prepare(['tank']);
  assert.equal(cinematics.frenzyBlade, null);
  cinematics.prepare(['frenzy']);
  assert.match(cinematics.frenzyBlade.src, /frenzy-blade\.webp$/);
  assert.match(cinematics.frenzyAwakened.src, /frenzy-awakened\.webp$/);
  const firstBlade = cinematics.frenzyBlade;
  cinematics.prepare(['frenzy']);
  assert.equal(cinematics.frenzyBlade, firstBlade);

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
