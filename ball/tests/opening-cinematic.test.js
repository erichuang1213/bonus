const test = require('node:test');
const assert = require('node:assert/strict');
const OpeningCinematic = require('../public/opening-cinematic.js');

test('intro, impact and three countdown beats fit the server opening window', () => {
  const { approach, impact, countdown, total } = OpeningCinematic.TIMING;
  assert.equal(approach + impact + countdown, total);
  assert.equal(total, 240);
  assert.equal(OpeningCinematic.phaseAt(0).phase, 'approach');
  assert.equal(OpeningCinematic.phaseAt(approach - 1).phase, 'approach');
  assert.equal(OpeningCinematic.phaseAt(approach).phase, 'impact');
  assert.equal(OpeningCinematic.phaseAt(approach + impact).countdownValue, 3);
  assert.equal(OpeningCinematic.phaseAt(approach + impact + 60).countdownValue, 2);
  assert.equal(OpeningCinematic.phaseAt(approach + impact + 120).countdownValue, 1);
  assert.equal(OpeningCinematic.phaseAt(total - 1).countdownValue, 1);
  assert.equal(OpeningCinematic.phaseAt(total).phase, 'done');
});
