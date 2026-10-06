(function (root) {
  const TIMING = Object.freeze({ approach: 42, impact: 18, countdown: 180, total: 240 });
  const TAU = Math.PI * 2;

  function clamp(value, low = 0, high = 1) { return Math.max(low, Math.min(high, value)); }
  function easeOut(value) { const t = clamp(value); return 1 - Math.pow(1 - t, 3); }

  function phaseAt(frame) {
    const current = Math.max(0, Math.floor(Number(frame) || 0));
    if (current < TIMING.approach) return { phase: 'approach', phaseFrame: current, countdownValue: 3 };
    if (current < TIMING.approach + TIMING.impact) return { phase: 'impact', phaseFrame: current - TIMING.approach, countdownValue: 3 };
    if (current < TIMING.total) {
      const phaseFrame = current - TIMING.approach - TIMING.impact;
      return { phase: 'countdown', phaseFrame, countdownValue: 3 - Math.floor(phaseFrame / 60) };
    }
    return { phase: 'done', phaseFrame: 0, countdownValue: 0 };
  }

  function polygon(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
  }

  function drawBackdrop(ctx, width, height, redColor, blueColor, intensity) {
    ctx.fillStyle = 'rgba(2, 8, 23, .81)';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.globalAlpha = .10 + intensity * .13;
    ctx.fillStyle = redColor;
    polygon(ctx, [[0, 0], [width * .58, 0], [width * .40, height], [0, height]]);
    ctx.fill();
    ctx.fillStyle = blueColor;
    polygon(ctx, [[width * .58, 0], [width, 0], [width, height], [width * .40, height]]);
    ctx.fill();
    ctx.restore();
  }

  function drawSigil(ctx, x, y, radius, color, frame, side, lowPower) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    const rings = lowPower ? 2 : 3;
    for (let ring = 0; ring < rings; ring++) {
      const r = radius + 17 + ring * 12;
      const rotation = side * frame * (.009 + ring * .003);
      ctx.globalAlpha = .56 - ring * .14;
      ctx.lineWidth = ring === 0 ? 3 : 1.5;
      for (let segment = 0; segment < 3; segment++) {
        const start = rotation + segment * TAU / 3;
        ctx.beginPath(); ctx.arc(0, 0, r, start, start + .47); ctx.stroke();
      }
    }
    if (!lowPower) {
      ctx.globalAlpha = .66;
      for (let dot = 0; dot < 3; dot++) {
        const angle = side * frame * .012 + dot * TAU / 3;
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * (radius + 44), Math.sin(angle) * (radius + 44), 3, 0, TAU);
        ctx.fillStyle = color; ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawHero(ctx, ball, x, y, frame, side, scale, lowPower, effectsDisabled) {
    if (!effectsDisabled) drawSigil(ctx, x, y, ball.radius * scale, ball.visual.ballStyle.borderColor, frame, side, lowPower);
    ball.drawAt(x, y, scale);
  }

  function drawImpact(ctx, width, height, frame, redColor, blueColor, lowPower) {
    const x = width / 2, y = height / 2;
    const progress = clamp(frame / TIMING.impact);
    ctx.save();
    ctx.translate(x, y);
    const count = lowPower ? 8 : 14;
    for (let i = 0; i < count; i++) {
      const angle = i * TAU / count + .09;
      const inner = 48 + progress * 75;
      const outer = inner + (1 - progress) * 150;
      ctx.save(); ctx.rotate(angle);
      ctx.globalAlpha = (1 - progress) * (i % 2 ? .48 : .7);
      ctx.fillStyle = i % 2 ? blueColor : redColor;
      polygon(ctx, [[inner, -3], [outer, -11], [outer + 25, 0], [outer, 11], [inner, 3]]);
      ctx.fill(); ctx.restore();
    }
    for (let ring = 0; ring < 2; ring++) {
      ctx.beginPath(); ctx.arc(0, 0, 45 + progress * (170 + ring * 55), 0, TAU);
      ctx.strokeStyle = ring ? blueColor : redColor;
      ctx.globalAlpha = (1 - progress) * .72;
      ctx.lineWidth = ring ? 3 : 5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1 - progress * .6;
    ctx.font = '900 76px Microsoft JhengHei, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f7f6ea'; ctx.fillText('VS', 0, 2);
    ctx.restore();
    if (frame < 4) {
      ctx.fillStyle = `rgba(255,255,255,${.28 * (1 - frame / 4)})`;
      ctx.fillRect(0, 0, width, height);
    }
  }

  function drawCountdown(ctx, width, height, frame, value, redColor, blueColor) {
    const x = width / 2, y = height / 2;
    const beat = frame % 60;
    const enter = easeOut(beat / 12);
    const numberScale = 1.18 - enter * .18;
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = 'rgba(4, 12, 29, .92)';
    polygon(ctx, [[-77, -88], [77, -88], [101, 0], [77, 88], [-77, 88], [-101, 0]]);
    ctx.fill();
    ctx.strokeStyle = '#e5ecf6'; ctx.globalAlpha = .7;
    ctx.lineWidth = 2; ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(0, 0, 112, -Math.PI / 2, -Math.PI / 2 + TAU * (beat / 60));
    ctx.strokeStyle = value === 1 ? '#f6d789' : value === 2 ? blueColor : redColor;
    ctx.lineWidth = 6; ctx.stroke();
    ctx.scale(numberScale, numberScale);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 104px Microsoft JhengHei, sans-serif';
    ctx.fillStyle = '#fffaf1'; ctx.fillText(String(value), 0, 7);
    ctx.restore();
  }

  function draw(ctx, options) {
    const { width, height, frame, p1, p2, lowPower = false, effectsDisabled = false, drawHeroIntro } = options;
    if (!p1 || !p2) return;
    const stage = phaseAt(frame);
    if (stage.phase === 'done') return;
    const redColor = p1.visual.ballStyle.borderColor;
    const blueColor = p2.visual.ballStyle.borderColor;
    const x1 = width * .28, x2 = width * .72, heroY = height * .52;
    ctx.save();
    drawBackdrop(ctx, width, height, redColor, blueColor, stage.phase === 'impact' ? 1 : .35);
    if (stage.phase === 'approach') {
      if (!effectsDisabled && drawHeroIntro) { drawHeroIntro(p1, frame); drawHeroIntro(p2, frame); }
      const enter = effectsDisabled ? 1 : easeOut(stage.phaseFrame / TIMING.approach);
      drawHero(ctx, p1, -width * .12 + (x1 + width * .12) * enter, heroY, frame, 1, .93 + enter * .12, lowPower, effectsDisabled);
      drawHero(ctx, p2, width * 1.12 - (width * 1.12 - x2) * enter, heroY, frame, -1, .93 + enter * .12, lowPower, effectsDisabled);
    } else {
      drawHero(ctx, p1, x1, heroY, frame, 1, 1.05, lowPower, effectsDisabled);
      drawHero(ctx, p2, x2, heroY, frame, -1, 1.05, lowPower, effectsDisabled);
      if (stage.phase === 'impact') {
        if (!effectsDisabled) drawImpact(ctx, width, height, stage.phaseFrame, redColor, blueColor, lowPower);
      } else {
        drawCountdown(ctx, width, height, stage.phaseFrame, stage.countdownValue, redColor, blueColor);
      }
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(238,245,255,.9)';
    ctx.font = '700 26px Microsoft JhengHei, sans-serif';
    ctx.fillText(stage.phase === 'countdown' ? '對決即將開始' : '雙球競技場', width / 2, height * .16);
    ctx.font = '700 26px Microsoft JhengHei, sans-serif';
    ctx.fillStyle = redColor; ctx.fillText(p1.visual.name, width * .26, height * .80);
    ctx.fillStyle = blueColor; ctx.fillText(p2.visual.name, width * .74, height * .80);
    ctx.restore();
  }

  const OpeningCinematic = Object.freeze({ TIMING, phaseAt, draw });
  if (typeof module !== 'undefined' && module.exports) module.exports = OpeningCinematic;
  else root.OpeningCinematic = OpeningCinematic;
})(globalThis);
