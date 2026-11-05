/* =========================================================================
   DUAL-DECK CANVAS RENDERER & SPECTRUM WAVE BARS
   ========================================================================= */

const Visualizer = {
  canvas: null,
  ctx: null,

  init(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.resize();

    window.addEventListener('resize', () => {
      this.resize();
      this.draw();
    });

    const frameContainer = document.getElementById('sweeper-frame-container');
    if (frameContainer && window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        this.resize();
        if (!State.isPlaying) {
          this.draw();
        }
      });
      ro.observe(frameContainer);
    }
  },

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
  },

  parseSpacedLine(text) {
    if (!text || !text.trim()) return [];
    const tokens = text.trim().split(/\s+/);
    const totalTokens = Math.max(tokens.length, 1);
    const items = [];

    tokens.forEach((raw, index) => {
      const token = raw.trim();
      if (!token || token === '.' || token === '-' || token === '_') return;
      const relPos = totalTokens === 1 ? 0 : (index / totalTokens);
      items.push({ text: token, relPos });
    });

    return items;
  },

  drawSpectrumPill(c, x, y, width, height, radius) {
    if (height <= 0) return;
    const r = Math.min(radius, width / 2, height);
    c.beginPath();
    c.moveTo(x, y + height);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.lineTo(x + width - r, y);
    c.quadraticCurveTo(x + width, y, x + width, y + r);
    c.lineTo(x + width, y + height);
    c.closePath();
    c.fill();
  },

  renderAudioSpectrumWaves(W, H, progress, isPlaying) {
    if (!State.settings.showSpectrum) return;

    const numBars = Math.floor(Math.min(54, Math.max(30, W / 18)));
    const barSpacing = 4;
    const totalWidth = W * 0.94;
    const startX = (W - totalWidth) / 2;
    const barWidth = Math.max(3, (totalWidth - (numBars - 1) * barSpacing) / numBars);
    const maxHeight = H * 0.32 * State.settings.spectrumIntensity;
    const baseY = H - 4;

    let freqArray = null;
    if (State.analyserNode && State.spectrumFreqData && isPlaying) {
      State.analyserNode.getByteFrequencyData(State.spectrumFreqData);
      freqArray = State.spectrumFreqData;
    }

    this.ctx.save();
    // Multi-stop horizontal gradient: Magenta -> Purple -> Blue -> Cyan
    const grad = this.ctx.createLinearGradient(startX, 0, startX + totalWidth, 0);
    grad.addColorStop(0.0, '#e024c3');
    grad.addColorStop(0.25, '#c026d3');
    grad.addColorStop(0.50, '#8b5cf6');
    grad.addColorStop(0.75, '#3b82f6');
    grad.addColorStop(1.0, '#06b6d4');
    this.ctx.fillStyle = grad;
    this.ctx.shadowColor = 'rgba(192, 38, 211, 0.45)';
    this.ctx.shadowBlur = 8;
    this.ctx.globalAlpha = 0.88 * Math.min(1.0, State.settings.spectrumIntensity + 0.15);

    const time = performance.now() * 0.003;

    for (let i = 0; i < numBars; i++) {
      let normalizedVal = 0;
      if (freqArray && isPlaying) {
        const binIndex = Math.floor((i / numBars) * (freqArray.length * 0.85));
        const rawByte = freqArray[binIndex] || 0;
        normalizedVal = rawByte / 255;
      } else if (isPlaying) {
        // Rhythm-reactive synthesized bounce if audio file is not loaded
        const wave1 = Math.sin(time * 2.2 + i * 0.28);
        const wave2 = Math.cos(time * 3.4 - i * 0.18);
        const beatBounce = Math.sin(progress * Math.PI) * 0.45;
        normalizedVal = Math.max(0.08, 0.28 + (wave1 * 0.2) + (wave2 * 0.15) + beatBounce);
      } else {
        // Subtle idle ambient ripple
        const idleWave = Math.sin(time * 0.8 + (i * 0.25)) * 0.5 + 0.5;
        normalizedVal = 0.06 + (idleWave * 0.09);
      }

      const barHeight = Math.max(4, normalizedVal * maxHeight);
      const bx = startX + i * (barWidth + barSpacing);
      const by = baseY - barHeight;

      this.drawSpectrumPill(this.ctx, bx, by, barWidth, barHeight, barWidth / 2);
    }

    this.ctx.restore();
  },

    draw() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const W = rect.width;
    const H = rect.height;


    const metrics = getTimingMetricsAt(State.currentTime);
    const beats = metrics.activePoint.beatsPerBar || 4;
    
    // Pin needle strictly to 0 when stopped or before the first beat
    const isAtStart = State.currentTime <= 0 || (metrics.globalBarIndex <= 1 && State.currentTime < (metrics.activePoint.offset || 0));
    const progress = isAtStart ? 0 : metrics.barProgress;
    State.currentGlobalBar = metrics.globalBarIndex;
    State.currentBeat = metrics.currentBeatInBar;

    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, W, H);

    // Render bottom spectrum frequency waves
    this.renderAudioSpectrumWaves(W, H, progress, State.isPlaying);

    const isTwoBar = State.settings.layoutMode === 'two_bar';
    const boundaryW = 6;
    const boundaryH = H * 0.65;
    const boundaryY = H * 0.10;
    const tickY = H - 32;
    const tickHeight = 22;
    const tickWidth = 6;
    const chordRowY = H * 0.28;
    const leadRowY = H * 0.58;

    const currentBar = metrics.globalBarIndex;
    const upcomingAlert = checkUpcomingChange(currentBar);
    const hasUpcomingChange = upcomingAlert && upcomingAlert.length > 0;

    if (isTwoBar) {
      /* MODE A: TWO-BAR ALTERNATING (PING-PONG) */
      const leftBoundaryX = W * 0.08;
      const midBoundaryX = W * 0.50;
      const rightBoundaryX = W * 0.92;

      const deckAWidth = midBoundaryX - leftBoundaryX;
      const deckBWidth = rightBoundaryX - midBoundaryX;

      const isCurrentOnDeckA = (currentBar % 2 === 1);
      const barNumDeckA = isCurrentOnDeckA ? currentBar : currentBar + 1;
      const barNumDeckB = isCurrentOnDeckA ? currentBar + 1 : currentBar;

      const barDataA = (barNumDeckA <= State.song.totalMeasures) ? (State.measures[barNumDeckA - 1] || { chordLine: "", leadLine: "" }) : { chordLine: "", leadLine: "" };
      const barDataB = (barNumDeckB <= State.song.totalMeasures) ? (State.measures[barNumDeckB - 1] || { chordLine: "", leadLine: "" }) : { chordLine: "", leadLine: "" };

      const chordsA = this.parseSpacedLine(barDataA.chordLine || "");
      const leadsA = this.parseSpacedLine(barDataA.leadLine || "");
      const chordsB = this.parseSpacedLine(barDataB.chordLine || "");
      const leadsB = this.parseSpacedLine(barDataB.leadLine || "");

      const beatsA = (getMetricsForBar(barNumDeckA).activePoint.beatsPerBar) || beats;
      const beatsB = (getMetricsForBar(barNumDeckB).activePoint.beatsPerBar) || beats;

      const beatWidthA = deckAWidth / beatsA;
      const beatWidthB = deckBWidth / beatsB;

      const safeProgress = Math.min(Math.max(progress, 0), 1.0);
      // When at start of deck, snap playhead center to match the boundary bar center
      const startSnapA = leftBoundaryX - (boundaryW / 2);
      const startSnapB = midBoundaryX;

      const playheadX = isCurrentOnDeckA
        ? (safeProgress === 0 ? startSnapA : leftBoundaryX + (deckAWidth * safeProgress))
        : (safeProgress === 0 ? startSnapB : midBoundaryX + (deckBWidth * safeProgress));

      // Deck A Header
      this.ctx.font = '700 12px "JetBrains Mono", monospace';
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'top';
      this.ctx.fillStyle = isCurrentOnDeckA ? '#facc15' : '#71717a';
      this.ctx.fillText(isCurrentOnDeckA ? `▶ BAR ${barNumDeckA}` : `NEXT: BAR ${barNumDeckA}`, leftBoundaryX + 8, H * 0.06);

      // Deck B Header
      this.ctx.fillStyle = !isCurrentOnDeckA ? '#facc15' : '#71717a';
      this.ctx.fillText(!isCurrentOnDeckA ? `▶ BAR ${barNumDeckB}` : `NEXT: BAR ${barNumDeckB}`, midBoundaryX + 16, H * 0.06);

      const deckInnerPad = 24;

      // Render Deck A Chords & Leads (Left Side)
      this.ctx.save();
      if (!isCurrentOnDeckA) this.ctx.globalAlpha = State.settings.previewOpacity;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';

      chordsA.forEach(item => {
        const availW = deckAWidth - (deckInnerPad * 2);
        let itemX = leftBoundaryX + deckInnerPad + (item.relPos * availW);
        this.ctx.font = '700 28px "JetBrains Mono", monospace';
        const halfW = (this.ctx.measureText(item.text).width / 2) + 4;
        itemX = Math.max(leftBoundaryX + halfW + 6, Math.min(midBoundaryX - halfW - 6, itemX));

        const isNearHit = isCurrentOnDeckA && Math.abs(playheadX - itemX) < (deckAWidth * 0.045);
        if (isNearHit) {
          this.ctx.font = '800 32px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#fde047';
          this.ctx.shadowColor = '#fde047';
          this.ctx.shadowBlur = 18;
          this.ctx.fillText(item.text, itemX, chordRowY);
          this.ctx.shadowBlur = 0;
        } else {
          this.ctx.fillStyle = isCurrentOnDeckA ? '#ffffff' : '#fef08a';
          this.ctx.fillText(item.text, itemX, chordRowY);
        }
      });

      leadsA.forEach(item => {
        const availW = deckAWidth - (deckInnerPad * 2);
        let itemX = leftBoundaryX + deckInnerPad + (item.relPos * availW);
        this.ctx.font = '700 28px "JetBrains Mono", monospace';
        const halfW = (this.ctx.measureText(item.text).width / 2) + 4;
        itemX = Math.max(leftBoundaryX + halfW + 6, Math.min(midBoundaryX - halfW - 6, itemX));

        const isNearHit = isCurrentOnDeckA && Math.abs(playheadX - itemX) < (deckAWidth * 0.045);
        if (isNearHit) {
          this.ctx.font = '800 32px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#38bdf8';
          this.ctx.shadowColor = '#38bdf8';
          this.ctx.shadowBlur = 18;
          this.ctx.fillText(item.text, itemX, leadRowY);
          this.ctx.shadowBlur = 0;
        } else {
          this.ctx.fillStyle = isCurrentOnDeckA ? '#cbd5e1' : '#7dd3fc';
          this.ctx.fillText(item.text, itemX, leadRowY);
        }
      });

      // Deck A Beat Ticks & 8th Subdivisions
      for (let b = 0; b < beatsA; b++) {
        const beatX = leftBoundaryX + (b * beatWidthA);
        this.ctx.fillStyle = isCurrentOnDeckA ? '#ffffff' : '#52525b';
        this.ctx.fillRect(beatX - tickWidth / 2, tickY, tickWidth, tickHeight);

        const subX = beatX + (beatWidthA * 0.5);
        this.ctx.fillStyle = isCurrentOnDeckA ? 'rgba(255, 255, 255, 0.35)' : 'rgba(82, 82, 91, 0.4)';
        this.ctx.fillRect(subX - (tickWidth * 0.5) / 2, tickY + tickHeight * 0.35, tickWidth * 0.5, tickHeight * 0.65);
      }
      this.ctx.restore();

      // Render Deck B Chords & Leads (Right Side)
      this.ctx.save();
      if (isCurrentOnDeckA) this.ctx.globalAlpha = State.settings.previewOpacity;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';

      chordsB.forEach(item => {
        const availW = deckBWidth - (deckInnerPad * 2);
        let itemX = midBoundaryX + deckInnerPad + (item.relPos * availW);
        this.ctx.font = '700 28px "JetBrains Mono", monospace';
        const halfW = (this.ctx.measureText(item.text).width / 2) + 4;
        itemX = Math.max(midBoundaryX + halfW + 6, Math.min(rightBoundaryX - halfW - 6, itemX));

        const isNearHit = !isCurrentOnDeckA && Math.abs(playheadX - itemX) < (deckBWidth * 0.045);
        if (isNearHit) {
          this.ctx.font = '800 32px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#fde047';
          this.ctx.shadowColor = '#fde047';
          this.ctx.shadowBlur = 18;
          this.ctx.fillText(item.text, itemX, chordRowY);
          this.ctx.shadowBlur = 0;
        } else {
          this.ctx.fillStyle = !isCurrentOnDeckA ? '#ffffff' : '#fef08a';
          this.ctx.fillText(item.text, itemX, chordRowY);
        }
      });

      leadsB.forEach(item => {
        const availW = deckBWidth - (deckInnerPad * 2);
        let itemX = midBoundaryX + deckInnerPad + (item.relPos * availW);
        this.ctx.font = '700 28px "JetBrains Mono", monospace';
        const halfW = (this.ctx.measureText(item.text).width / 2) + 4;
        itemX = Math.max(midBoundaryX + halfW + 6, Math.min(rightBoundaryX - halfW - 6, itemX));

        const isNearHit = !isCurrentOnDeckA && Math.abs(playheadX - itemX) < (deckBWidth * 0.045);
        if (isNearHit) {
          this.ctx.font = '800 32px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#38bdf8';
          this.ctx.shadowColor = '#38bdf8';
          this.ctx.shadowBlur = 18;
          this.ctx.fillText(item.text, itemX, leadRowY);
          this.ctx.shadowBlur = 0;
        } else {
          this.ctx.fillStyle = !isCurrentOnDeckA ? '#cbd5e1' : '#7dd3fc';
          this.ctx.fillText(item.text, itemX, leadRowY);
        }
      });

      // Deck B Beat Ticks & 8th Subdivisions
      for (let b = 0; b < beatsB; b++) {
        const beatX = midBoundaryX + (b * beatWidthB);
        this.ctx.fillStyle = !isCurrentOnDeckA ? '#ffffff' : '#52525b';
        this.ctx.fillRect(beatX - tickWidth / 2, tickY, tickWidth, tickHeight);

        const subX = beatX + (beatWidthB * 0.5);
        this.ctx.fillStyle = !isCurrentOnDeckA ? 'rgba(255, 255, 255, 0.35)' : 'rgba(82, 82, 91, 0.4)';
        this.ctx.fillRect(subX - (tickWidth * 0.5) / 2, tickY + tickHeight * 0.35, tickWidth * 0.5, tickHeight * 0.65);
      }
      this.ctx.restore();

      // Boundary Bars
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(leftBoundaryX - boundaryW, boundaryY, boundaryW, boundaryH * 0.44);
      this.ctx.fillRect(leftBoundaryX - boundaryW, boundaryY + boundaryH * 0.56, boundaryW, boundaryH * 0.44);

      if (hasUpcomingChange) {
        this.ctx.fillStyle = '#facc15';
        this.ctx.shadowColor = '#facc15';
        this.ctx.shadowBlur = 12;
      } else {
        this.ctx.fillStyle = '#52525b';
        this.ctx.shadowBlur = 0;
      }
      this.ctx.fillRect(midBoundaryX - boundaryW / 2, boundaryY, boundaryW, boundaryH * 0.44);
      this.ctx.fillRect(midBoundaryX - boundaryW / 2, boundaryY + boundaryH * 0.56, boundaryW, boundaryH * 0.44);
      this.ctx.shadowBlur = 0;

      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(rightBoundaryX, boundaryY, boundaryW, boundaryH * 0.44);
      this.ctx.fillRect(rightBoundaryX, boundaryY + boundaryH * 0.56, boundaryW, boundaryH * 0.44);

      // Sweeping Needle - perfectly aligned to boundary bar width & height
      const needleW = 8;
      const needleH = boundaryH;
      const needleY = boundaryY;

      this.ctx.save();
      this.ctx.shadowColor = '#fde047';
      this.ctx.shadowBlur = 12;
      this.ctx.fillStyle = '#fde047';
      this.ctx.fillRect(playheadX - needleW / 2, needleY, needleW, needleH);

      // Top indicator arrow
      this.ctx.beginPath();
      this.ctx.moveTo(playheadX - 6, needleY - 8);
      this.ctx.lineTo(playheadX + 6, needleY - 8);
      this.ctx.lineTo(playheadX, needleY);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.restore();

    } else {
      /* MODE B: SINGLE-BAR CLASSIC */
      const leftBoundaryX = W * 0.15;
      const rightBoundaryX = W * 0.85;
      const barPlayWidth = rightBoundaryX - leftBoundaryX;
      const beatWidth = barPlayWidth / beats;
      const playheadX = leftBoundaryX + (barPlayWidth * progress);

      const barIdx = currentBar - 1;
      const barData = State.measures[barIdx] || { chordLine: "", leadLine: "" };
      const parsedChords = this.parseSpacedLine(barData.chordLine || "");
      const parsedLeads = this.parseSpacedLine(barData.leadLine || "");

      const nextBarData = (currentBar < State.song.totalMeasures) ? (State.measures[currentBar] || { chordLine: "", leadLine: "" }) : { chordLine: "", leadLine: "" };
      const nextChords = this.parseSpacedLine(nextBarData.chordLine || "");

      const singleInnerPad = 26;
      const availSingleW = barPlayWidth - (singleInnerPad * 2);

      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';

      parsedChords.forEach(item => {
        let itemX = leftBoundaryX + singleInnerPad + (item.relPos * availSingleW);
        this.ctx.font = '700 30px "JetBrains Mono", monospace';
        const halfW = (this.ctx.measureText(item.text).width / 2) + 4;
        itemX = Math.max(leftBoundaryX + halfW + 8, Math.min(rightBoundaryX - halfW - 8, itemX));

        const isNearHit = Math.abs(playheadX - itemX) < (barPlayWidth * 0.045);
        if (isNearHit) {
          this.ctx.font = '800 36px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#fde047';
          this.ctx.shadowColor = '#fde047';
          this.ctx.shadowBlur = 18;
          this.ctx.fillText(item.text, itemX, chordRowY);
          this.ctx.shadowBlur = 0;
        } else {
          this.ctx.fillStyle = '#ffffff';
          this.ctx.fillText(item.text, itemX, chordRowY);
        }
      });

      parsedLeads.forEach(item => {
        let itemX = leftBoundaryX + singleInnerPad + (item.relPos * availSingleW);
        this.ctx.font = '700 30px "JetBrains Mono", monospace';
        const halfW = (this.ctx.measureText(item.text).width / 2) + 4;
        itemX = Math.max(leftBoundaryX + halfW + 8, Math.min(rightBoundaryX - halfW - 8, itemX));

        const isNearHit = Math.abs(playheadX - itemX) < (barPlayWidth * 0.045);
        if (isNearHit) {
          this.ctx.font = '800 36px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#38bdf8';
          this.ctx.shadowColor = '#38bdf8';
          this.ctx.shadowBlur = 18;
          this.ctx.fillText(item.text, itemX, leadRowY);
          this.ctx.shadowBlur = 0;
        } else {
          this.ctx.fillStyle = '#cbd5e1';
          this.ctx.fillText(item.text, itemX, leadRowY);
        }
      });

      if (State.settings.beat4Ghosting && progress >= 0.72 && nextChords.length > 0) {
        const ghostAlpha = Math.min(0.65, (progress - 0.72) / 0.28 * 0.65);
        this.ctx.save();
        this.ctx.globalAlpha = ghostAlpha;
        nextChords.forEach(item => {
          const itemX = leftBoundaryX + (item.relPos * barPlayWidth) + (beatWidth * 0.35);
          this.ctx.font = '700 28px "JetBrains Mono", monospace';
          this.ctx.fillStyle = '#fef08a';
          this.ctx.fillText(item.text, itemX, chordRowY);
        });
        this.ctx.restore();
      }

      for (let b = 0; b < beats; b++) {
        const beatX = leftBoundaryX + (b * beatWidth);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(beatX - tickWidth / 2, tickY, tickWidth, tickHeight);

        const subX = beatX + (beatWidth * 0.5);
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        this.ctx.fillRect(subX - (tickWidth * 0.5) / 2, tickY + tickHeight * 0.35, tickWidth * 0.5, tickHeight * 0.65);
      }

      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(leftBoundaryX - boundaryW, boundaryY, boundaryW, boundaryH * 0.44);
      this.ctx.fillRect(leftBoundaryX - boundaryW, boundaryY + boundaryH * 0.56, boundaryW, boundaryH * 0.44);

      if (hasUpcomingChange) {
        this.ctx.fillStyle = '#facc15';
        this.ctx.shadowColor = '#facc15';
        this.ctx.shadowBlur = 12;
      } else {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowBlur = 0;
      }
      this.ctx.fillRect(rightBoundaryX, boundaryY, boundaryW, boundaryH * 0.44);
      this.ctx.fillRect(rightBoundaryX, boundaryY + boundaryH * 0.56, boundaryW, boundaryH * 0.44);
      this.ctx.shadowBlur = 0;

      const barWidth = 10;
      const barHeight = H * 0.78;
      const barY = H * 0.05;
      this.ctx.shadowColor = '#fef08a';
      this.ctx.shadowBlur = 10;
      this.ctx.fillStyle = '#fef08a';
      this.ctx.fillRect(playheadX - barWidth / 2, barY, barWidth, barHeight);
      this.ctx.shadowBlur = 0;
    }
  }
};