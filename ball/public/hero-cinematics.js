(function (root) {
  const DURATION_MS = 1100;
  const DAWN_CINEMATIC_IMAGE = '/assets/heroes/dawn-cinematic.webp';

  function clamp01(value) { return Math.max(0, Math.min(1, value)); }
  function easeOut(value) { const t = clamp01(value); return 1 - Math.pow(1 - t, 3); }

  class HeroCinematics {
    constructor() {
      this.active = null;
      this.queue = [];
      this.dawnImage = new Image();
      this.dawnImage.src = DAWN_CINEMATIC_IMAGE;
    }

    reset() { this.active = null; this.queue.length = 0; }

    playDawn(ball) {
      if (!ball || ball.roleId !== 'dawn') return;
      if (this.active?.playerTag === ball.playerTag || this.queue.some((item) => item.playerTag === ball.playerTag)) return;
      const item = { playerTag: ball.playerTag, image: ball.ballImageObj, startedAt: performance.now() };
      if (this.active) this.queue.push(item);
      else this.active = item;
    }

    getDawnImage(fallback) {
      return this.dawnImage.complete && this.dawnImage.naturalWidth > 0 ? this.dawnImage : fallback;
    }

    drawIntro(ctx, ball, frame, width, height) {
      if (!ball || ball.roleId !== 'dawn') return;
      const image = this.getDawnImage(ball.ballImageObj);
      if (!image?.complete || !image.naturalWidth) return;
      const enter = easeOut(frame / 35);
      const leave = 1 - easeOut(Math.max(0, frame - 48) / 24);
      const alpha = Math.min(0.32, enter * leave * 0.32);
      if (alpha <= 0) return;
      const side = ball.playerTag === 'p1' ? 1 : -1;
      const x = side === 1 ? width * (0.24 - (1 - enter) * 0.2) : width * (0.76 + (1 - enter) * 0.2);
      const size = Math.min(width, height) * (0.65 + enter * 0.10);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, height * 0.49);
      ctx.rotate(side * (1 - enter) * -0.12);
      ctx.drawImage(image, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    draw(ctx, width, height, now, lowPower = false, effectsDisabled = false) {
      if (!this.active) return;
      let age = now - this.active.startedAt;
      if (age >= DURATION_MS) {
        this.active = this.queue.shift() || null;
        if (!this.active) return;
        this.active.startedAt = now;
        age = 0;
      }
      if (effectsDisabled) return;

      const image = this.getDawnImage(this.active.image);
      const enter = easeOut(age / 280);
      const fade = 1 - easeOut(Math.max(0, age - 830) / 270);
      const phase = clamp01(age / DURATION_MS);
      const centerX = width * 0.66;
      const centerY = height * 0.44;
      const side = this.active.playerTag === 'p1' ? 1 : -1;

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.fillStyle = 'rgba(3, 9, 27, .82)';
      ctx.fillRect(0, 0, width, height);

      const halo = ctx.createRadialGradient(centerX, centerY, 25, centerX, centerY, width * 0.55);
      halo.addColorStop(0, 'rgba(255, 236, 157, .58)');
      halo.addColorStop(0.42, 'rgba(226, 132, 38, .22)');
      halo.addColorStop(1, 'rgba(226, 132, 38, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);

      const rayCount = lowPower ? 6 : 10;
      for (let i = 0; i < rayCount; i++) {
        const angle = i * Math.PI * 2 / rayCount + phase * 0.3;
        ctx.save(); ctx.translate(centerX, centerY); ctx.rotate(angle);
        ctx.fillStyle = i % 2 ? 'rgba(255, 191, 80, .10)' : 'rgba(255, 231, 158, .16)';
        ctx.beginPath(); ctx.moveTo(42, -8); ctx.lineTo(width * 0.65, -26); ctx.lineTo(width * 0.65, 26); ctx.lineTo(42, 8); ctx.closePath(); ctx.fill();
        ctx.restore();
      }

      if (image?.complete && image.naturalWidth) {
        const size = Math.min(width, height) * (0.64 + enter * 0.23);
        const x = centerX + (1 - enter) * width * 0.58 * side;
        const y = centerY + Math.sin(age * 0.012) * 5;
        ctx.save(); ctx.translate(x, y); ctx.rotate(side * (1 - enter) * 0.16);
        // 封閉裝甲先進場，再逐步切換成展開裝甲，而不是直接閃出另一張圖。
        const awakening = easeOut(Math.max(0, age - 150) / 260);
        const sealedImage = this.active.image;
        if (sealedImage?.complete && sealedImage.naturalWidth && awakening < 1) {
          ctx.globalAlpha = fade * (1 - awakening);
          ctx.drawImage(sealedImage, -size / 2, -size / 2, size, size);
        }
        ctx.globalAlpha = fade * awakening;
        ctx.drawImage(image, -size / 2, -size / 2, size, size);
        ctx.restore();
      }

      ctx.strokeStyle = 'rgba(255, 226, 146, .75)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(centerX, centerY, 210 + enter * 34, -Math.PI * 0.82, Math.PI * 0.42); ctx.stroke();
      ctx.beginPath(); ctx.arc(centerX, centerY, 230 + enter * 28, Math.PI * 0.17, Math.PI * 1.15); ctx.stroke();

      // 橫向光刃掃過裝甲，讓立繪有一個清楚的覺醒瞬間。
      if (age > 180 && age < 720) {
        const sweep = (age - 180) / 540;
        const slashX = -width * 0.2 + sweep * width * 1.5;
        ctx.save(); ctx.translate(slashX, height * 0.54); ctx.rotate(-0.35);
        const slash = ctx.createLinearGradient(-24, 0, 24, 0);
        slash.addColorStop(0, 'rgba(255,255,255,0)'); slash.addColorStop(0.5, 'rgba(255,250,211,.86)'); slash.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = slash; ctx.fillRect(-24, -height, 48, height * 2);
        ctx.restore();
      }

      const titleX = width * 0.065;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f7d889'; ctx.font = `bold ${Math.round(width * 0.023)}px Microsoft JhengHei, sans-serif`;
      ctx.fillText('守曦者・無晝', titleX, height * 0.68);
      ctx.fillStyle = '#fff5d7'; ctx.font = `bold ${Math.round(width * 0.071)}px Microsoft JhengHei, sans-serif`;
      ctx.fillText('黎明必至', titleX, height * 0.77);
      ctx.fillStyle = 'rgba(255, 224, 154, .86)'; ctx.fillRect(titleX, height * 0.79, width * 0.34 * enter, 3);
      ctx.restore();
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = HeroCinematics;
  else root.HeroCinematics = HeroCinematics;
})(globalThis);
