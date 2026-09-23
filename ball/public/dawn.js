(function (root) {
  const Dawn = {
    start(b) { b.energy = 0; b.dawnUlt = 180; b.dawnShield = 180; b.dawnShieldLife = 180; b.dawnHits = 2; b.dawnHitCd = 0; },
    energy(b, amount) { if (b.dawnUlt > 0 || b.hp <= 0) return; b.energy = Math.min(100, b.energy + amount); if (b.energy >= 100) this.start(b); },
    damage(b, amount, reflected = false) {
      const absorbed = Math.min(b.dawnShield || 0, amount); b.dawnShield = (b.dawnShield || 0) - absorbed;
      const lost = Math.min(b.hp, amount - absorbed);
      if (!reflected) b.dawnEmber = Math.min(120, (b.dawnEmber || 0) + absorbed * .5 + lost * .3);
      return lost;
    },
    body(b) {
      if (b.dawnBodyCd > 0) return 0;
      b.dawnBodyCd = 12;
      const ember = Math.min(40, b.dawnEmber || 0); b.dawnEmber = (b.dawnEmber || 0) - ember;
      let bonus = 0;
      if (b.dawnUlt > 0 && b.dawnHits > 0 && !(b.dawnHitCd > 0)) { bonus = 45; b.dawnHits--; b.dawnHitCd = 30; }
      return 40 + ember + bonus;
    },
    tick(b) {
      b.dawnClock = (b.dawnClock || 0) + 1;
      if (b.dawnUlt > 0) b.dawnUlt--;
      if (b.dawnHitCd > 0) b.dawnHitCd--;
      if (b.dawnBodyCd > 0) b.dawnBodyCd--;
      if (b.dawnShieldLife > 0 && --b.dawnShieldLife === 0) b.dawnShield = 0;
      if (b.dawnClock % 300 === 0 && !(b.dawnUlt > 0)) { b.dawnShield = 100; b.dawnShieldLife = 90; }
      const speed = (b.dawnUlt > 0 ? 14 : (b.baseSpeed || 10.5)) * (1 - Math.min(5, b.magmaStacks || 0) * .06);
      const length = Math.hypot(b.vx, b.vy) || 1; b.vx = b.vx / length * speed; b.vy = b.vy / length * speed;
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Dawn;
  else root.Dawn = Dawn;
})(globalThis);
