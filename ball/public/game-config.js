(function (root) {
  // 這份資料同時供大廳、單機與伺服器使用；不要在各頁複製基礎數值。
  const roles = Object.freeze({
    dawn: Object.freeze({ hp: 2200, speed: 10.5, radius: 100, skill: 'dawn' }),
    speeder: Object.freeze({ hp: 2000, speed: 12.2, radius: 100, skill: 'none' }),
    tank: Object.freeze({ hp: 2000, speed: 12.2, radius: 100, skill: 'none' }),
    frenzy: Object.freeze({ hp: 2000, speed: 12.2, radius: 100, skill: 'sword' }),
    magma: Object.freeze({ hp: 2400, speed: 9.2, radius: 100, skill: 'magma' }),
    nova: Object.freeze({ hp: 1850, speed: 11.5, radius: 100, skill: 'joker' }),
    clone: Object.freeze({ hp: 2000, speed: 12.2, radius: 100, skill: 'missile' }),
  });
  const GameConfig = Object.freeze({ roles, roleIds: Object.freeze(Object.keys(roles)) });
  if (typeof module !== 'undefined' && module.exports) module.exports = GameConfig;
  else root.GameConfig = GameConfig;
})(globalThis);
