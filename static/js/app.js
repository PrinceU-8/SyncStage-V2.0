/* =========================================================================
   SYNSTAGE APPLICATION CONTROLLER, TRANSPOSITION & BACKEND INTEGRATION
   ========================================================================= */

// 1. Hydrate state directly from the backend JSON script tag
const backendPayloadEl = document.getElementById('initial-project-data');
const backendData = backendPayloadEl ? JSON.parse(backendPayloadEl.textContent) : {};

// Check session-cached timing points as fallback if refreshed
let initialTimingPoints = backendData.timingPoints && backendData.timingPoints.length ? backendData.timingPoints : [
  { id: 1, offset: 0.00, bpm: backendData.bpm || 120, beatsPerBar: backendData.beatsPerBar || 4 }
];
try {
  const cachedTpStr = sessionStorage.getItem(`syncstage_tp_${backendData.projectId || 'root'}`);
  if (cachedTpStr) {
    const cachedTp = JSON.parse(cachedTpStr);
    if (Array.isArray(cachedTp) && cachedTp.length > 0) {
      if (initialTimingPoints.length === 1 && initialTimingPoints[0].offset === 0 && cachedTp[0].offset !== 0) {
        initialTimingPoints = cachedTp;
      } else if (!backendData.timingPoints || backendData.timingPoints.length <= 1) {
        initialTimingPoints = cachedTp;
      }
    }
  }
} catch (e) {}

const State = {
  projectId: backendData.projectId || null,
  isLocked: !!backendData.isLocked,
  song: {
    title: backendData.title || "UNTITLED PROJECT",
    key: backendData.key || "C",
    totalMeasures: backendData.totalMeasures || 8
  },
  settings: {
    layoutMode: "two_bar",
    beat4Ghosting: true,
    previewOpacity: 0.50,
    showSpectrum: true,
    spectrumIntensity: 0.70
  },
  selectedSectionId: 1,
  collapsedSections: new Set(),
  collapsedSongs: new Set(),
  selectedBars: new Set(),
  multiBarClipboard: null,
  isMedleyMode: false,
  sections: backendData.sections && backendData.sections.length ? backendData.sections : [
    { id: 1, startBar: 1, name: "Section 1", color: "#facc15", isNewSong: true, songTitle: backendData.title || "UNTITLED PROJECT", songKey: backendData.key || "C" }
  ],
  timingPoints: initialTimingPoints,
  measures: backendData.measures && backendData.measures.length ? backendData.measures : [],
  isPlaying: false,
  currentTime: 0,
  audioCtxStartTime: 0,
  songPlaybackOffset: 0,
  loopBar: false,
  loopTargetBar: 1,
  currentGlobalBar: 1,
  currentBeat: 1,
  totalDuration: 16.0,
  audioBuffer: null,
  audioSource: null,
  audioGainNode: null,
  audioCtx: null,
  analyserNode: null,
  spectrumFreqData: null,
  musicVolume: 0.8,
  metronomeEnabled: true,
  metronomeVolume: 0.8,
  isVideoMode: false
};

// Global session edit PIN holder
let currentProjectPin = null;

// Ensure measures array length matches totalMeasures
while (State.measures.length < State.song.totalMeasures) {
  State.measures.push({ bar: State.measures.length + 1, chordLine: "", leadLine: "" });
}

/* =========================================================================
   PROJECT SNAPSHOT & UNSAVED PROGRESS DETECTION
   ========================================================================= */
let lastSavedSnapshot = null;
let currentAudioFile = null;

function getProjectSnapshot() {
  return JSON.stringify({
    title: (State.song.title || '').trim().toUpperCase(),
    key: (State.song.key || '').trim().toUpperCase(),
    totalMeasures: State.song.totalMeasures || 8,
    timingPoints: (State.timingPoints || []).map(tp => ({
      offset: Math.round((tp.offset || 0) * 1000) / 1000,
      bpm: Math.round((tp.bpm || 120) * 100) / 100,
      beatsPerBar: tp.beatsPerBar || 4
    })),
    sections: (State.sections || []).map(s => ({
      startBar: s.startBar,
      name: (s.name || '').trim(),
      color: s.color || '#facc15',
      isNewSong: !!s.isNewSong,
      songTitle: (s.songTitle || '').trim(),
      songKey: (s.songKey || '').trim()
    })),
    measures: (State.measures || []).map(m => ({
      bar: m.bar,
      chordLine: (m.chordLine || '').trim(),
      leadLine: (m.leadLine || '').trim()
    }))
  });
}

function hasStudioContent() {
  const hasChords = (State.measures || []).some(m => (m.chordLine && m.chordLine.trim()) || (m.leadLine && m.leadLine.trim()));
  const hasAudio = !!State.audioBuffer;
  const hasCustomSections = (State.sections || []).length > 1 || ((State.sections || [])[0] && State.sections[0].name !== 'Section 1');
  const hasCustomTitle = State.song.title && State.song.title.trim().toUpperCase() !== 'UNTITLED PROJECT';
  return Boolean(hasChords || hasAudio || hasCustomSections || hasCustomTitle);
}

function hasUnsavedChanges() {
  if (!State.projectId) {
    return hasStudioContent();
  }
  if (currentAudioFile) {
    return true;
  }
  if (lastSavedSnapshot) {
    return getProjectSnapshot() !== lastSavedSnapshot;
  }
  return false;
}

lastSavedSnapshot = getProjectSnapshot();

/* =========================================================================
   2. COLOR PALETTES & SECTION HELPERS
   ========================================================================= */
const SONG_PALETTES = [
  { name: "Amber Gold",   base: "#facc15", intro: "#eab308", verse: "#fde047", pre: "#f59e0b", chorus: "#fbbf24", bridge: "#d97706", outro: "#ca8a04", other: "#fef08a" },
  { name: "Ocean Blue",   base: "#38bdf8", intro: "#0284c7", verse: "#60a5fa", pre: "#38bdf8", chorus: "#2563eb", bridge: "#0ea5e9", outro: "#1d4ed8", other: "#93c5fd" },
  { name: "Emerald Mint", base: "#4ade80", intro: "#16a34a", verse: "#22c55e", pre: "#86efac", chorus: "#15803d", bridge: "#10b981", outro: "#047857", other: "#bbf7d0" },
  { name: "Crimson Rose", base: "#f87171", intro: "#dc2626", verse: "#fb7185", pre: "#f43f5e", chorus: "#e11d48", bridge: "#be123c", outro: "#9f1239", other: "#fda4af" },
  { name: "Royal Violet", base: "#c084fc", intro: "#7c3aed", verse: "#a855f7", pre: "#d8b4fe", chorus: "#6d28d9", bridge: "#9333ea", outro: "#5b21b6", other: "#e9d5ff" },
  { name: "Sunset Orange",base: "#fb923c", intro: "#ea580c", verse: "#f97316", pre: "#fdba74", chorus: "#c2410c", bridge: "#d97706", outro: "#9a3412", other: "#fed7aa" }
];

function getSongPalette(songIndex) {
  return SONG_PALETTES[Math.abs(songIndex) % SONG_PALETTES.length];
}

function getSectionColorFromPalette(palette, secName) {
  const lower = (secName || '').toLowerCase().trim();
  if (lower.includes('intro')) return palette.intro;
  if (lower.includes('verse')) return palette.verse;
  if (lower.includes('pre')) return palette.pre;
  if (lower.includes('chorus') || lower.includes('hook') || lower.includes('refrain')) return palette.chorus;
  if (lower.includes('bridge') || lower.includes('vamp')) return palette.bridge;
  if (lower.includes('tag')) return palette.outro;
  if (lower.includes('interlude') || lower.includes('instrumental') || lower.includes('solo')) return palette.other;
  if (lower.includes('transition')) return palette.pre;
  if (lower.includes('outro') || lower.includes('ending')) return palette.outro;
  return palette.other;
}

function getSectionAtBar(barNumber) {
  const sorted = [...State.sections].sort((a, b) => a.startBar - b.startBar);
  let active = null;
  let activeSongSection = null;

  for (let sec of sorted) {
    if (barNumber >= sec.startBar) {
      active = sec;
      if (sec.isNewSong) activeSongSection = sec;
    } else {
      break;
    }
  }

  let songTitle = State.song.title;
  let songKey = (active && active.songKey) ? active.songKey : State.song.key;

  if (State.isMedleyMode && activeSongSection && activeSongSection.songTitle) {
    songTitle = activeSongSection.songTitle;
    songKey = (active && active.songKey) ? active.songKey : (activeSongSection.songKey || State.song.key);
  }

  return {
    ...(active || { name: "Section", color: "#facc15", startBar: 1, isNewSong: false, songKey: State.song.key }),
    currentSongTitle: songTitle,
    currentSongKey: songKey
  };
}

/* =========================================================================
   3. CHROMATIC MULTI-LEVEL TRANSPOSITION ENGINE
   ========================================================================= */
const CHROMATIC_SCALE_SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHROMATIC_SCALE_FLATS  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_TO_SEMITONE = {
  'B#': 0, 'C': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3,
  'E': 4, 'FB': 4, 'E#': 5, 'F': 5, 'F#': 6, 'GB': 6, 'G': 7,
  'G#': 8, 'AB': 8, 'A': 9, 'A#': 10, 'BB': 10, 'B': 11, 'CB': 11
};

function transposeNote(noteName, semitones, preferFlats = false) {
  if (!noteName) return noteName;
  const clean = noteName.toUpperCase().trim();
  if (!(clean in NOTE_TO_SEMITONE)) return noteName;
  const currentVal = NOTE_TO_SEMITONE[clean];
  const targetVal = (currentVal + semitones + 120) % 12;
  return preferFlats ? CHROMATIC_SCALE_FLATS[targetVal] : CHROMATIC_SCALE_SHARPS[targetVal];
}

function transposeChordToken(token, semitones, preferFlats = false) {
  if (!token || token === '.' || token === '-' || token === '_') return token;
  if (token.includes('/')) {
    const parts = token.split('/');
    return `${transposeChordToken(parts[0], semitones, preferFlats)}/${transposeChordToken(parts[1], semitones, preferFlats)}`;
  }
  const match = token.match(/^([A-Ga-g][#b]?)(.*)$/);
  if (!match) return token;
  return transposeNote(match[1], semitones, preferFlats) + (match[2] || '');
}

function transposeLeadToken(token, semitones, preferFlats = false) {
  if (!token || token === '.' || token === '-' || token === '_') return token;
  const match = token.match(/^([A-Ga-g][#b]?)(\d+)?$/);
  if (!match) return transposeChordToken(token, semitones, preferFlats);
  const note = match[1];
  let octave = match[2] ? parseInt(match[2], 10) : 5;
  const currentVal = NOTE_TO_SEMITONE[note.toUpperCase()];
  if (currentVal === undefined) return token;
  const rawTarget = currentVal + semitones;
  octave += Math.floor(rawTarget / 12);
  const transposed = transposeNote(note, semitones, preferFlats);
  return match[2] ? `${transposed}${octave}` : transposed;
}

function transposeSpacedLine(line, semitones, isLead = false, preferFlats = false) {
  if (!line) return '';
  return line.replace(/(\S+)/g, (token) => {
    if (token === '.' || token === '-' || token === '_') return token;
    return isLead ? transposeLeadToken(token, semitones, preferFlats) : transposeChordToken(token, semitones, preferFlats);
  });
}

function transposeEntireProject(semitones) {
  if (semitones === 0) return;
  const preferFlats = ['F', 'BB', 'EB', 'AB', 'DB'].includes((State.song.key || '').toUpperCase());
  State.song.key = transposeNote(State.song.key, semitones, preferFlats);
  const keyInput = document.getElementById('edit-song-key');
  if (keyInput) keyInput.value = State.song.key;

  State.sections.forEach(sec => {
    if (sec.songKey) sec.songKey = transposeNote(sec.songKey, semitones, preferFlats);
  });

  State.measures.forEach(m => {
    if (m.chordLine) m.chordLine = transposeSpacedLine(m.chordLine, semitones, false, preferFlats);
    if (m.leadLine)  m.leadLine  = transposeSpacedLine(m.leadLine,  semitones, true,  preferFlats);
  });

  updateEngine();
  showToast(`Global pitch: ${semitones > 0 ? '+' + semitones : semitones} st → Key ${State.song.key}`);
}

function transposeSingleSection(startBar, endBar, semitones, sec) {
  if (semitones === 0) return;
  const currentKey = sec.songKey || State.song.key;
  const preferFlats = ['F', 'BB', 'EB', 'AB', 'DB'].includes(currentKey.toUpperCase());
  sec.songKey = transposeNote(currentKey, semitones, preferFlats);

  for (let b = startBar; b <= endBar; b++) {
    const m = State.measures[b - 1];
    if (m) {
      if (m.chordLine) m.chordLine = transposeSpacedLine(m.chordLine, semitones, false, preferFlats);
      if (m.leadLine)  m.leadLine  = transposeSpacedLine(m.leadLine,  semitones, true,  preferFlats);
    }
  }

  updateEngine();
  showToast(`${sec.name} shifted: ${semitones > 0 ? '+' + semitones : semitones} st`);
}

function showToast(msg) {
  const statusEl = document.getElementById('copy-status-msg');
  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.className = "text-amber-400 font-mono text-[10px] font-bold";
    setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = "ready"; }, 2500);
  }
}

/* =========================================================================
   4. TIMING & DURATION CALCULATIONS
   ========================================================================= */
function getSortedTimingPoints() {
  return [...State.timingPoints].sort((a, b) => a.offset - b.offset);
}

function getTimingMetricsAt(time) {
  const points = getSortedTimingPoints();
  if (!points.length) points.push({ id: 1, offset: 0, bpm: 120, beatsPerBar: 4 });

  let activeIndex = 0;
  for (let i = 0; i < points.length; i++) {
    if (time >= points[i].offset) activeIndex = i;
    else break;
  }

  const activePoint = points[activeIndex];
  const secondsPerBeat = 60 / activePoint.bpm;
  const beatsPerBar = activePoint.beatsPerBar || 4;
  const secondsPerBar = secondsPerBeat * beatsPerBar;

  let accumulatedBars = 0;
  for (let i = 0; i < activeIndex; i++) {
    const span = Math.max(0, points[i + 1].offset - points[i].offset);
    const curSecPerBar = (60 / points[i].bpm) * (points[i].beatsPerBar || 4);
    accumulatedBars += Math.round(span / curSecPerBar);
  }

  const timeSincePoint = time - activePoint.offset;
  let barProgress = 0;
  let currentBeatInBar = 1;
  let globalBarIndex = 1;

  if (time <= 0 || time < activePoint.offset) {
    barProgress = 0.0;
    currentBeatInBar = 1;
    globalBarIndex = 1;
  } else {
    const barsSince = timeSincePoint / secondsPerBar;
    barProgress = (timeSincePoint % secondsPerBar) / secondsPerBar;
    currentBeatInBar = Math.floor(barProgress * beatsPerBar) + 1;
    globalBarIndex = Math.floor(accumulatedBars + Math.floor(barsSince)) + 1;
  }

  return {
    activePoint,
    barProgress: Math.min(Math.max(barProgress || 0, 0), 0.9999),
    currentBeatInBar: Math.min(Math.max(currentBeatInBar, 1), beatsPerBar),
    globalBarIndex: Math.max(1, globalBarIndex)
  };
}

function getTimeForBarStart(targetBar) {
  if (targetBar <= 1) return State.timingPoints.length ? State.timingPoints[0].offset : 0;
  const points = getSortedTimingPoints();
  let accumulatedBars = 0;
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const next = points[i + 1];
    const spBar = (60 / cur.bpm) * (cur.beatsPerBar || 4);
    if (next) {
      const wholeBars = Math.round(Math.max(0, next.offset - cur.offset) / spBar);
      if (targetBar <= accumulatedBars + wholeBars) {
        return Math.max(0, cur.offset + ((targetBar - (accumulatedBars + 1)) * spBar));
      }
      accumulatedBars += wholeBars;
    } else {
      return Math.max(0, cur.offset + ((targetBar - (accumulatedBars + 1)) * spBar));
    }
  }
  return 0;
}

function getMetricsForBar(targetBar) {
  return getTimingMetricsAt(Math.max(0, getTimeForBarStart(targetBar) + 0.001));
}

function checkUpcomingChange(currentBar) {
  const nextBar = currentBar + 1;
  if (nextBar > State.song.totalMeasures) return null;
  const curMetrics = getMetricsForBar(currentBar);
  const nextMetrics = getMetricsForBar(nextBar);
  const alerts = [];

  if ((curMetrics.activePoint.beatsPerBar || 4) !== (nextMetrics.activePoint.beatsPerBar || 4)) {
    alerts.push({ type: 'meter', short: `${nextMetrics.activePoint.beatsPerBar || 4}/4 METER` });
  }
  if (Math.abs(Math.round(nextMetrics.activePoint.bpm) - Math.round(curMetrics.activePoint.bpm)) >= 2) {
    alerts.push({ type: 'bpm', short: `${Math.round(nextMetrics.activePoint.bpm)} BPM` });
  }
  return alerts.length > 0 ? alerts : null;
}

function recalculateTotalDuration() {
  const finalBarEndTime = getTimeForBarStart(State.song.totalMeasures + 1);
  State.totalDuration = (State.audioBuffer && State.audioBuffer.duration > 0)
    ? Math.max(State.audioBuffer.duration, finalBarEndTime)
    : Math.max(finalBarEndTime, 10);
  updateScrubberBounds();
}

function updateEngine() {
  recalculateTotalDuration();
  renderTimingPoints();
  renderSectionsList();
  renderMeasuresEditor();
  renderOverviewTimeline();
  renderTimelineMarkers();
  if (State.isPlaying && typeof AudioEngine !== 'undefined' && AudioEngine.resync) {
    AudioEngine.resync();
  }
}

function updateHeaderDisplay(metrics) {
  const activeTp = metrics.activePoint;
  const bpmEl = document.getElementById('vis-bpm');
  const timesigEl = document.getElementById('vis-timesig');
  const barNumEl = document.getElementById('vis-bar-num');
  if (bpmEl) bpmEl.textContent = Math.round(activeTp.bpm);
  if (timesigEl) timesigEl.textContent = `${activeTp.beatsPerBar}/4`;
  if (barNumEl) barNumEl.textContent = `${metrics.globalBarIndex} / ${State.song.totalMeasures}`;

  const activeOffsetEl = document.getElementById('active-point-offset');
  if (activeOffsetEl) {
    const activeBpmEl = document.getElementById('active-point-bpm');
    const activeMeterEl = document.getElementById('active-point-meter');
    if (activeBpmEl) activeBpmEl.textContent = Math.round(activeTp.bpm);
    activeOffsetEl.textContent = activeTp.offset.toFixed(3) + 's';
    if (activeMeterEl) activeMeterEl.textContent = `${activeTp.beatsPerBar}/4`;
  }

  const sec = getSectionAtBar(metrics.globalBarIndex);
  const secBadge = document.getElementById('vis-section-badge');
  if (secBadge && sec) {
    secBadge.textContent = sec.name.toUpperCase();
    secBadge.style.backgroundColor = sec.color || '#facc15';
    secBadge.style.boxShadow = `0 0 12px ${sec.color}44`;
  }

  const titleEl = document.getElementById('vis-title');
  const keyEl = document.getElementById('vis-key');
  if (titleEl) titleEl.textContent = (sec.currentSongTitle && State.isMedleyMode ? sec.currentSongTitle : State.song.title).toUpperCase();
  if (keyEl) keyEl.textContent = sec.currentSongKey || State.song.key;
}

function formatTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function formatTimePrecise(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

function updateScrubberBounds() {
  const scrub = document.getElementById('timeline-scrubber');
  if (scrub) scrub.max = State.totalDuration;
  const totalEl = document.getElementById('scrub-total');
  if (totalEl) totalEl.textContent = formatTime(State.totalDuration);
}

function updateScrubberUI() {
  const scrub = document.getElementById('timeline-scrubber');
  if (scrub) scrub.value = State.currentTime;
  const curEl = document.getElementById('scrub-current');
  if (curEl) curEl.textContent = formatTime(State.currentTime);
  const timeDisp = document.getElementById('timeline-time-display');
  if (timeDisp) timeDisp.textContent = `${formatTimePrecise(State.currentTime)} / ${formatTimePrecise(State.totalDuration)}`;
  const needle = document.getElementById('timeline-needle');
  if (needle) needle.style.left = `${State.totalDuration > 0 ? (State.currentTime / State.totalDuration * 100).toFixed(2) : 0}%`;
}

function seekToTime(targetTime) {
  State.currentTime = Math.max(0, Math.min(State.totalDuration, targetTime));
  if (State.isPlaying) AudioEngine.start(State.currentTime);
  updateScrubberUI();
  updateHeaderDisplay(getTimingMetricsAt(State.currentTime));
  renderOverviewTimeline();
  if (typeof Visualizer !== 'undefined' && Visualizer.draw) {
    Visualizer.draw();
  }
}

function seekToBar(targetBar) {
  seekToTime(getTimeForBarStart(targetBar) + 0.001);
}

/* =========================================================================
   5. UI RENDERING (MARKERS, OVERVIEW, SECTIONS & MEASURES)
   ========================================================================= */
function renderTimelineMarkers() {
  const container = document.getElementById('timeline-markers-track');
  if (!container || State.totalDuration <= 0) return;
  container.innerHTML = '';

  const sorted = [...State.sections].sort((a, b) => a.startBar - b.startBar);
  sorted.forEach((sec, idx) => {
    const barStartTime = getTimeForBarStart(sec.startBar);
    const barEndTime = sorted[idx + 1] ? getTimeForBarStart(sorted[idx + 1].startBar) : State.totalDuration;
    const spanPct = Math.max(0.5, ((barEndTime / State.totalDuration) - (barStartTime / State.totalDuration)) * 100);

    const seg = document.createElement('div');
    seg.className = "h-full relative flex items-center justify-center border-r border-black/40 overflow-hidden cursor-pointer select-none transition-opacity hover:opacity-90";
    seg.style.width = `${spanPct}%`;
    seg.style.backgroundColor = sec.color || '#facc15';

    if (spanPct > 5.5) {
      seg.innerHTML = `
        <span class="text-[9px] font-mono font-black text-black/90 uppercase tracking-tighter truncate px-1 pointer-events-none">
          ${sec.name}
        </span>
      `;
    }

    seg.addEventListener('click', (e) => { e.stopPropagation(); seekToBar(sec.startBar); });
    container.appendChild(seg);
  });
}

function setupTimelineTooltip() {
  const wrapper = document.getElementById('timeline-interactive-wrapper');
  const tooltip = document.getElementById('timeline-hover-tooltip');
  const tooltipText = document.getElementById('tooltip-text');
  if (!wrapper || !tooltip || !tooltipText) return;

  const updateTooltipPosition = (e) => {
    const rect = wrapper.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = rect.width > 0 ? (offsetX / rect.width) : 0;
    const hoverTime = ratio * State.totalDuration;

    const metrics = getTimingMetricsAt(hoverTime);
    const sec = getSectionAtBar(metrics.globalBarIndex);

    tooltip.style.left = `${offsetX}px`;
    tooltipText.textContent = `${sec.name.toUpperCase()} • Bar ${metrics.globalBarIndex} (${formatTimePrecise(hoverTime)})`;
    tooltip.classList.remove('hidden');
  };

  wrapper.addEventListener('mousemove', updateTooltipPosition);
  wrapper.addEventListener('mouseenter', () => tooltip.classList.remove('hidden'));
  wrapper.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
}

function renderOverviewTimeline() {
  const container = document.getElementById('overview-bar-container');
  if (!container) return;
  container.innerHTML = '';
  const currentBar = State.currentGlobalBar || 1;

  for (let i = 0; i < 4; i++) {
    const targetBar = currentBar + i;
    const barCard = document.createElement('div');
    if (targetBar <= State.song.totalMeasures) {
      const isCurrent = (i === 0);
      const isNextBar = (i === 1);
      const barAlerts = targetBar > 1 ? checkUpcomingChange(targetBar - 1) : null;
      const hasBarAlert = barAlerts && barAlerts.length > 0;

      const barData = State.measures[targetBar - 1] || { chordLine: "", leadLine: "" };
      const chordText = barData.chordLine.replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim() || '—';
      const leadText = barData.leadLine.replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim() || '—';
      const sec = getSectionAtBar(targetBar);

      barCard.className = `h-full rounded-lg border p-1.5 flex flex-col justify-between cursor-pointer transition select-none font-mono ${
        isCurrent
          ? 'bg-amber-400/20 border-amber-400 text-amber-300 ring-2 ring-amber-400/50 shadow-lg'
          : (isNextBar && hasBarAlert)
          ? 'bg-amber-950/40 border-2 border-amber-400 text-white ring-2 ring-amber-400/40 shadow-lg animate-pulse'
          : hasBarAlert
          ? 'bg-zinc-900 border border-amber-400/60 text-zinc-200'
          : 'bg-zinc-900/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
      }`;

      barCard.innerHTML = `
        <div class="flex items-center justify-between text-[10px]">
          <span class="font-bold uppercase ${isCurrent ? 'text-amber-300' : hasBarAlert ? 'text-amber-400 font-extrabold' : 'text-zinc-400'}">
            ${isCurrent ? '▶ BAR ' + targetBar : hasBarAlert ? '⚡ BAR ' + targetBar : 'BAR ' + targetBar}
          </span>
          ${hasBarAlert ? `
            <span class="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-amber-400 text-black border border-amber-300 shadow truncate max-w-[110px]">
              ⚡ ${barAlerts.map(a => a.short).join(' ')}
            </span>
          ` : `
            <span class="text-[9px] font-medium text-zinc-500 uppercase truncate max-w-[60px]">
              ${sec.name}
            </span>
          `}
        </div>
        <div class="truncate text-xs md:text-sm font-extrabold ${isCurrent ? 'text-white' : hasBarAlert ? 'text-amber-200' : 'text-zinc-200'}">${chordText}</div>
        <div class="truncate text-[10px] font-semibold ${isCurrent ? 'text-sky-300' : 'text-zinc-400'}">${leadText}</div>
      `;
      barCard.addEventListener('click', () => { seekToBar(targetBar); State.loopTargetBar = targetBar; });
    } else {
      barCard.className = "h-full rounded-lg border border-zinc-900 bg-zinc-950/40 p-1.5 flex flex-col justify-center items-center text-zinc-700 font-mono text-xs select-none";
      barCard.innerHTML = `<span>END</span>`;
    }
    container.appendChild(barCard);
  }
}

function updateSelectedSectionUI() {
  const pill = document.getElementById('active-selected-sec-pill-tab2');
  const targetSec = State.sections.find(s => s.id === State.selectedSectionId) || State.sections[0];
  if (!pill) return;
  if (targetSec) {
    pill.textContent = targetSec.name;
    pill.style.color = targetSec.color || '#facc15';
    pill.style.borderColor = (targetSec.color || '#facc15') + '66';
    pill.style.backgroundColor = (targetSec.color || '#facc15') + '22';
  }
}

function renderSectionsList() {
  const container = document.getElementById('sections-list-container');
  if (!container) return;
  container.innerHTML = '';

  const sorted = [...State.sections].sort((a, b) => a.startBar - b.startBar);

  sorted.forEach((sec) => {
    const isSelected = (State.selectedSectionId === sec.id);
    const item = document.createElement('div');
    item.className = `bg-zinc-950 border ${
      isSelected 
        ? 'border-amber-400 ring-2 ring-amber-400/50 bg-amber-950/20 shadow-md' 
        : sec.isNewSong && State.isMedleyMode 
        ? 'border-amber-400/60 ring-1 ring-amber-400/30' 
        : 'border-zinc-800'
    } rounded p-2.5 flex flex-col text-xs gap-2 transition-all cursor-pointer`;
    
    item.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 flex-1 flex-wrap">
          <input type="radio" name="selected_section_radio" class="sec-select-radio accent-amber-400 cursor-pointer" ${isSelected ? 'checked' : ''} title="Select this section for quick rename">
          <input type="color" value="${sec.color || '#facc15'}" class="sec-color-input w-5 h-5 rounded cursor-pointer bg-transparent border-0 p-0">
          <input type="text" value="${sec.name}" class="sec-name-input bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-white font-mono font-bold w-28 uppercase">
          
          <div class="flex items-center gap-1 text-[10px] font-mono text-zinc-400">
            <span>Bar:</span>
            <input type="number" min="1" max="${State.song.totalMeasures}" value="${sec.startBar}" class="sec-bar-input w-12 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200 font-mono text-center">
          </div>

          <div class="flex items-center gap-1 text-[10px] font-mono text-amber-400" title="Key signature for this section">
            <span>Key:</span>
            <input type="text" value="${sec.songKey || State.song.key}" class="sec-key-direct-input w-10 bg-zinc-900 border border-amber-400/40 rounded px-1 py-0.5 text-[10px] text-amber-300 font-mono font-bold text-center uppercase">
          </div>
        </div>
        
        <div class="flex items-center gap-1 shrink-0">
          <button class="btn-jump-sec p-1 text-zinc-400 hover:text-amber-400" title="Jump to section downbeat">
            <i class="ph ph-arrow-circle-right text-base"></i>
          </button>
          <button class="btn-del-sec p-1 text-zinc-400 hover:text-red-400" title="Delete Section">
            <i class="ph ph-trash text-base"></i>
          </button>
        </div>
      </div>

      <div class="pt-1.5 border-t border-zinc-900 flex flex-col gap-1.5">
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" class="sec-newsong-chk accent-amber-400 w-3.5 h-3.5 rounded" ${sec.isNewSong ? 'checked' : ''}>
          <span class="text-[11px] font-bold ${sec.isNewSong ? 'text-amber-300' : 'text-zinc-400'} flex items-center gap-1">
            <i class="ph-bold ph-music-notes"></i> Set as New Song in Medley
          </span>
        </label>

        ${sec.isNewSong ? `
          <div class="grid grid-cols-3 gap-1.5 pl-5 pt-0.5">
            <div class="col-span-3">
              <span class="text-[9px] font-mono text-zinc-500 uppercase block">Song Title</span>
              <input type="text" value="${sec.songTitle || sec.name}" class="sec-songtitle-input w-full bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-white font-mono uppercase">
            </div>
          </div>
        ` : ''}
      </div>
    `;

    item.onclick = (e) => {
      if (e.target.closest('input') || e.target.closest('button')) return;
      State.selectedSectionId = sec.id;
      updateSelectedSectionUI();
      renderSectionsList();
      renderMeasuresEditor();
    };

    const radioBtn = item.querySelector('.sec-select-radio');
    if (radioBtn) {
      radioBtn.onchange = () => {
        State.selectedSectionId = sec.id;
        updateSelectedSectionUI();
        renderSectionsList();
        renderMeasuresEditor();
      };
    }

    const colorIn = item.querySelector('.sec-color-input');
    if (colorIn) {
      colorIn.oninput = (e) => {
        sec.color = e.target.value;
        updateEngine();
      };
    }

    const nameIn = item.querySelector('.sec-name-input');
    if (nameIn) {
      nameIn.onchange = (e) => {
        sec.name = e.target.value.trim() || 'Section';
        if (sec.isNewSong && !sec.songTitle) sec.songTitle = sec.name;
        updateSelectedSectionUI();
        updateEngine();
      };
    }

    const barIn = item.querySelector('.sec-bar-input');
    if (barIn) {
      barIn.onchange = (e) => {
        sec.startBar = Math.max(1, Math.min(State.song.totalMeasures, parseInt(e.target.value, 10) || 1));
        updateEngine();
      };
    }

    const keyIn = item.querySelector('.sec-key-direct-input');
    if (keyIn) {
      keyIn.onchange = (e) => {
        sec.songKey = e.target.value.trim().toUpperCase() || State.song.key;
        updateEngine();
      };
    }

    const newsongChk = item.querySelector('.sec-newsong-chk');
    if (newsongChk) {
      newsongChk.onchange = (e) => {
        sec.isNewSong = e.target.checked;
        if (sec.isNewSong && !sec.songTitle) {
          sec.songTitle = `${sec.name.toUpperCase()} - NEW SONG`;
          if (!sec.songKey) sec.songKey = State.song.key;
        }
        if (sec.isNewSong && !State.isMedleyMode) {
          State.isMedleyMode = true;
          const medChk = document.getElementById('toggle-medley-mode');
          if (medChk) medChk.checked = true;
        }
        renderSectionsList();
        updateEngine();
      };
    }

    const titleIn = item.querySelector('.sec-songtitle-input');
    if (titleIn) {
      titleIn.onchange = (e) => {
        sec.songTitle = e.target.value.trim().toUpperCase() || 'UNTITLED';
        updateEngine();
      };
    }

    const jumpBtn = item.querySelector('.btn-jump-sec');
    if (jumpBtn) {
      jumpBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        seekToBar(sec.startBar);
      };
    }

    const delBtn = item.querySelector('.btn-del-sec');
    if (delBtn) {
      delBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        State.sections = State.sections.filter(s => s.id !== sec.id);
        if (State.selectedSectionId === sec.id && State.sections.length > 0) {
          State.selectedSectionId = State.sections[0].id;
        }
        updateEngine();
      };
    }

    container.appendChild(item);
  });

  updateSelectedSectionUI();
}

function setupPresetRenameButtons() {
  document.querySelectorAll('.btn-preset-rename').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const newName = btn.getAttribute('data-name');
      if (!newName) return;

      let targetSec = State.sections.find(s => s.id === State.selectedSectionId);
      if (!targetSec && State.sections.length > 0) {
        targetSec = State.sections[0];
        State.selectedSectionId = targetSec.id;
      }

      if (targetSec) {
        targetSec.name = newName;
        if (targetSec.isNewSong && !targetSec.songTitle) {
          targetSec.songTitle = newName;
        }

        const songsBefore = State.sections.filter(s => s.isNewSong && s.startBar <= targetSec.startBar).length;
        const songPalette = getSongPalette(Math.max(0, songsBefore - 1));
        targetSec.color = getSectionColorFromPalette(songPalette, newName);

        updateSelectedSectionUI();
        updateEngine();
      }
    };
  });
}

function updateSelectionUI() {
  const count = State.selectedBars.size;
  const countLbl = document.getElementById('batch-selection-count-lbl');
  const masterChk = document.getElementById('chk-master-select-all');

  if (countLbl) {
    countLbl.textContent = `${count} bar${count === 1 ? '' : 's'} selected`;
    countLbl.className = count > 0 ? "text-[11px] font-mono font-bold text-amber-300" : "text-[11px] font-mono font-normal text-zinc-400";
  }

  if (masterChk) {
    masterChk.checked = (count > 0 && count === State.song.totalMeasures);
    masterChk.indeterminate = (count > 0 && count < State.song.totalMeasures);
  }
}

function renderMeasuresEditor() {
  const list = document.getElementById('measures-editor-list');
  if (!list) return;
  list.innerHTML = '';

  while (State.measures.length < State.song.totalMeasures) {
    State.measures.push({ bar: State.measures.length + 1, chordLine: "", leadLine: "" });
  }

  const sortedSections = [...State.sections].sort((a, b) => a.startBar - b.startBar);
  if (!sortedSections.length || sortedSections[0].startBar > 1) {
    sortedSections.unshift({ id: 'default_sec', startBar: 1, name: 'Section 1', color: '#facc15' });
  }

  sortedSections.forEach((sec, idx) => {
    const nextSec = sortedSections[idx + 1];
    const start = sec.startBar;
    const end = nextSec ? Math.min(State.song.totalMeasures, nextSec.startBar - 1) : State.song.totalMeasures;
    if (start > State.song.totalMeasures || start > end) return;

    const secWrapper = document.createElement('div');
    secWrapper.className = "flex flex-col border border-zinc-800 rounded-lg p-2 bg-zinc-900/40 mb-2";

    const secHeader = document.createElement('div');
    secHeader.className = "flex items-center justify-between px-2 py-1 bg-zinc-900 rounded text-xs font-mono mb-2 gap-2 flex-wrap";
    secHeader.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full" style="background-color: ${sec.color || '#facc15'};"></span>
        <span class="font-bold text-white uppercase">${sec.name}</span>
        <span class="text-[9px] text-zinc-500">Bars ${start}–${end}</span>
        <div class="flex items-center gap-1 ml-2 bg-zinc-950 px-1 py-0.5 rounded border border-zinc-800 text-[9px]">
          <span class="text-zinc-500">Pitch:</span>
          <button type="button" class="btn-sec-tr-down px-1.5 py-0.2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold">-1</button>
          <button type="button" class="btn-sec-tr-up px-1.5 py-0.2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold">+1</button>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <button class="btn-copy-sec px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-amber-400 hover:text-black text-amber-300 text-[9px] font-bold border border-amber-400/30 flex items-center gap-1">
          <i class="ph-bold ph-copy"></i> Copy Sec
        </button>
        <button class="btn-paste-sec px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-green-400 hover:text-black text-green-300 text-[9px] font-bold border border-green-400/30 flex items-center gap-1">
          <i class="ph-bold ph-clipboard"></i> Paste Sec
        </button>
        <button class="btn-jump-sec text-[10px] text-zinc-400 hover:text-amber-400 px-1 py-0.5" title="Jump to section downbeat">
          <i class="ph-bold ph-arrow-circle-right text-sm"></i>
        </button>
      </div>
    `;

    secHeader.querySelector('.btn-sec-tr-down').onclick = () => transposeSingleSection(start, end, -1, sec);
    secHeader.querySelector('.btn-sec-tr-up').onclick = () => transposeSingleSection(start, end, 1, sec);
    secHeader.querySelector('.btn-jump-sec').onclick = () => seekToBar(start);
    secHeader.querySelector('.btn-copy-sec').onclick = () => {
      const copied = [];
      for (let b = start; b <= end; b++) {
        const m = State.measures[b - 1];
        if (m) copied.push({ chordLine: m.chordLine || '', leadLine: m.leadLine || '' });
      }
      State.multiBarClipboard = copied;
      showToast(`Copied ${sec.name} (${copied.length} bars)`);
    };
    secHeader.querySelector('.btn-paste-sec').onclick = () => {
      if (!State.multiBarClipboard || !State.multiBarClipboard.length) return;
      State.multiBarClipboard.forEach((item, idx) => {
        const targetIdx = (start - 1) + idx;
        if (targetIdx < State.measures.length) {
          State.measures[targetIdx].chordLine = item.chordLine;
          State.measures[targetIdx].leadLine = item.leadLine;
        }
      });
      showToast(`Pasted into ${sec.name}`);
      updateEngine();
    };

    secWrapper.appendChild(secHeader);

    for (let b = start; b <= end; b++) {
      const barNum = b;
      const m = State.measures[barNum - 1];
      if (!m) continue;

      const isSelectedBar = State.selectedBars.has(barNum);
      const row = document.createElement('div');
      row.className = `border rounded p-1.5 text-xs flex flex-col gap-1 mb-1.5 transition ${
        isSelectedBar ? 'bg-amber-950/30 border-amber-400/60 ring-1 ring-amber-400/30' : 'bg-zinc-950/80 border-zinc-850'
      }`;
      row.innerHTML = `
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <input type="checkbox" class="bar-select-chk accent-amber-400 w-3.5 h-3.5 cursor-pointer rounded" ${isSelectedBar ? 'checked' : ''}>
            <span class="font-mono font-bold ${isSelectedBar ? 'text-amber-300' : 'text-zinc-300'} text-[11px]">Bar ${barNum}</span>
          </div>
          <div class="flex items-center gap-1">
            <button class="btn-copy-bar text-[9px] text-zinc-400 hover:text-amber-300 px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded flex items-center gap-1">
              <i class="ph ph-copy"></i> Copy
            </button>
            <button class="btn-paste-bar text-[9px] text-zinc-400 hover:text-green-300 px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded flex items-center gap-1">
              <i class="ph ph-clipboard"></i> Paste
            </button>
            <button class="btn-dup-next text-[9px] text-zinc-400 hover:text-sky-300 px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded flex items-center gap-1">
              <i class="ph ph-copy-simple"></i> +Next
            </button>
            <button class="jump-bar-btn text-[9px] text-zinc-400 hover:text-white px-1 py-0.5 rounded font-mono">Jump</button>
          </div>
        </div>
        <input type="text" value="${m.chordLine || ''}" placeholder="Chords (e.g. C . G .)" class="chord-line-in w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-xs text-amber-300 font-mono font-bold uppercase">
        <input type="text" value="${m.leadLine || ''}" placeholder="Leads (e.g. E5 . D5 .)" class="lead-line-in w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-xs text-sky-200 font-mono font-semibold">
      `;

      row.querySelector('.bar-select-chk').onchange = (e) => {
        if (e.target.checked) State.selectedBars.add(barNum);
        else State.selectedBars.delete(barNum);
        updateSelectionUI();
        renderMeasuresEditor();
      };

      row.querySelector('.chord-line-in').oninput = (e) => { m.chordLine = e.target.value; renderOverviewTimeline(); };
      row.querySelector('.lead-line-in').oninput = (e) => { m.leadLine = e.target.value; renderOverviewTimeline(); };
      row.querySelector('.jump-bar-btn').onclick = () => seekToBar(barNum);

      row.querySelector('.btn-copy-bar').onclick = () => {
        State.multiBarClipboard = [{ chordLine: m.chordLine || '', leadLine: m.leadLine || '' }];
        showToast(`Copied Bar ${barNum}`);
      };

      row.querySelector('.btn-paste-bar').onclick = () => {
        if (State.multiBarClipboard && State.multiBarClipboard.length > 0) {
          const item = State.multiBarClipboard[0];
          m.chordLine = item.chordLine;
          m.leadLine = item.leadLine;
          updateEngine();
          showToast(`Pasted Bar ${barNum}`);
        }
      };

      row.querySelector('.btn-dup-next').onclick = () => {
        const nextIdx = barNum;
        if (nextIdx < State.measures.length) {
          State.measures[nextIdx].chordLine = m.chordLine;
          State.measures[nextIdx].leadLine = m.leadLine;
          updateEngine();
          showToast(`Duplicated Bar ${barNum} → ${barNum + 1}`);
        }
      };

      secWrapper.appendChild(row);
    }

    list.appendChild(secWrapper);
  });

  updateSelectionUI();
}

function renderTimingPoints() {
  const list = document.getElementById('timing-points-list');
  if (!list) return;
  list.innerHTML = '';

  getSortedTimingPoints().forEach((tp) => {
    const item = document.createElement('div');
    item.className = "bg-zinc-950 border border-zinc-800 rounded p-2.5 flex items-center justify-between text-xs";
    item.innerHTML = `
      <div class="flex items-center gap-2">
        <input type="number" min="30" max="320" value="${tp.bpm}" class="tp-bpm-input w-16 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-white font-mono font-bold">
        <span class="text-zinc-400 font-mono text-[11px]">BPM</span>
        <select class="tp-meter-select bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[11px] text-amber-300 font-mono font-bold">
          <option value="4" ${tp.beatsPerBar === 4 ? 'selected' : ''}>4/4</option>
          <option value="3" ${tp.beatsPerBar === 3 ? 'selected' : ''}>3/4</option>
          <option value="6" ${tp.beatsPerBar === 6 ? 'selected' : ''}>6/8</option>
          <option value="2" ${tp.beatsPerBar === 2 ? 'selected' : ''}>2/4</option>
        </select>
        <span class="text-[10px] font-mono text-zinc-400 ml-2">Offset:</span>
        <input type="number" step="0.001" min="0" value="${tp.offset.toFixed(3)}" class="tp-offset-input w-16 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200 font-mono">
      </div>
      <button class="btn-jump-tp p-1 text-zinc-400 hover:text-amber-400"><i class="ph ph-arrow-circle-right text-base"></i></button>
    `;

    const persistTimingPoints = () => {
      try {
        sessionStorage.setItem(`syncstage_tp_${State.projectId || 'root'}`, JSON.stringify(State.timingPoints));
      } catch (err) {}
    };
    item.querySelector('.tp-bpm-input').onchange = (e) => { tp.bpm = parseFloat(e.target.value) || 120; persistTimingPoints(); updateEngine(); };
    item.querySelector('.tp-meter-select').onchange = (e) => { tp.beatsPerBar = parseInt(e.target.value, 10) || 4; persistTimingPoints(); updateEngine(); };
    item.querySelector('.tp-offset-input').onchange = (e) => { tp.offset = parseFloat(e.target.value) || 0; persistTimingPoints(); updateEngine(); };
    item.querySelector('.btn-jump-tp').onclick = () => seekToTime(tp.offset);
    list.appendChild(item);
  });
}

/* =========================================================================
   6. OSU PARSER & BEATMAP INGESTION
   ========================================================================= */
function parseOsuBeatmap(fileContent) {
  if (!fileContent || typeof fileContent !== 'string') return null;
  const lines = fileContent.split(/\r?\n/);
  let currentSection = '';
  const parsed = { title: '', artist: '', timingPoints: [] };

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.substring(1, line.length - 1);
      continue;
    }
    if (currentSection === 'Metadata') {
      if (line.startsWith('Title:')) parsed.title = line.substring('Title:'.length).trim();
      else if (line.startsWith('Artist:')) parsed.artist = line.substring('Artist:'.length).trim();
    } else if (currentSection === 'TimingPoints') {
      const parts = line.split(',');
      if (parts.length >= 2) {
        const timeMs = parseFloat(parts[0]);
        const beatLength = parseFloat(parts[1]);
        const meter = parts[2] ? parseInt(parts[2], 10) : 4;
        let isUninherited = parts.length > 6 ? parts[6].trim() === '1' : beatLength > 0;
        if (isUninherited && beatLength > 0) {
          parsed.timingPoints.push({
            offset: Math.max(0, timeMs / 1000),
            bpm: Math.round((60000 / beatLength) * 100) / 100,
            beatsPerBar: meter > 0 ? meter : 4
          });
        }
      }
    }
  }
  parsed.timingPoints.sort((a, b) => a.offset - b.offset);
  return parsed;
}

function applyParsedOsuBeatmap(parsed) {
  if (!parsed || !parsed.timingPoints.length) return;
  if (parsed.title) {
    State.song.title = `${parsed.artist ? parsed.artist + ' - ' : ''}${parsed.title}`.toUpperCase();
    const titleIn = document.getElementById('edit-song-title');
    if (titleIn) titleIn.value = State.song.title;
  }
  State.timingPoints = parsed.timingPoints.map((tp, idx) => ({ id: idx + 1, ...tp }));
  try {
    sessionStorage.setItem(`syncstage_tp_${State.projectId || 'root'}`, JSON.stringify(State.timingPoints));
  } catch (err) {}
  updateEngine();
}

/* =========================================================================
   7. STAGE MODE (FULL SCREEN & OFF-CANVAS DRAWER)
   ========================================================================= */
function enterStageMode() {
  State.isVideoMode = true;

  const header = document.getElementById('main-header');
  const transport = document.getElementById('transport-controls-card');
  const stageControls = document.getElementById('video-mode-controls');
  if (header) header.classList.add('hidden');
  if (transport) transport.classList.add('hidden');
  if (stageControls) stageControls.classList.remove('hidden');

  const sidebar = document.getElementById('main-sidebar');
  if (sidebar) {
    sidebar.className = 'fixed top-0 right-0 bottom-0 w-[440px] max-w-[90vw] z-50 shadow-2xl hidden bg-zinc-950/95 backdrop-blur-md border-l border-zinc-800 p-4 flex flex-col gap-3 min-h-0';
  }

  const stageCol = document.getElementById('main-stage-col');
  if (stageCol) {
    stageCol.className = 'fixed inset-0 w-screen h-screen z-40 bg-black flex flex-col p-3 md:p-5 overflow-hidden';
  }

  const visWrapper = document.getElementById('visualizer-wrapper');
  if (visWrapper) {
    visWrapper.className = 'relative w-full h-full flex flex-col justify-between p-4 md:p-6 bg-black border-0 rounded-none screen-canvas-container select-none max-w-none';
  }

  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }

  setTimeout(() => {
    Visualizer.resize();
    Visualizer.draw();
  }, 60);
}

function exitStageMode() {
  State.isVideoMode = false;

  const header = document.getElementById('main-header');
  const transport = document.getElementById('transport-controls-card');
  const stageControls = document.getElementById('video-mode-controls');
  if (header) header.classList.remove('hidden');
  if (transport) transport.classList.remove('hidden');
  if (stageControls) stageControls.classList.add('hidden');

  const sidebar = document.getElementById('main-sidebar');
  if (sidebar) {
    sidebar.className = 'w-full xl:w-[480px] 2xl:w-[520px] h-full max-h-screen border-t xl:border-t-0 xl:border-l border-zinc-800 bg-zinc-900/80 p-3 md:p-4 flex flex-col gap-3 transition-all duration-200 min-h-0 flex-shrink-0 z-40';
  }

  const stageCol = document.getElementById('main-stage-col');
  if (stageCol) {
    stageCol.className = 'flex-1 flex flex-col p-3 md:p-5 bg-zinc-950 overflow-y-auto min-h-0 transition-all duration-200';
  }

  const visWrapper = document.getElementById('visualizer-wrapper');
  if (visWrapper) {
    visWrapper.className = 'relative w-full aspect-[16/9] max-w-5xl mx-auto rounded-xl overflow-hidden screen-canvas-container border border-zinc-800 flex flex-col justify-between p-5 select-none transition-all duration-200';
  }

  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }

  setTimeout(() => {
    Visualizer.resize();
    Visualizer.draw();
  }, 80);
}

function toggleStageDrawer() {
  const sidebar = document.getElementById('main-sidebar');
  if (sidebar) {
    sidebar.classList.toggle('hidden');
  }
}

/* =========================================================================
   8. SAVED SONG LIBRARY & DJANGO REST PERSISTENCE
   ========================================================================= */
function openSongLibrary() {
  const modal = document.getElementById('project-library-modal');
  const list = document.getElementById('saved-songs-list');
  if (!modal || !list) return;

  list.innerHTML = '<div class="text-xs text-zinc-500 font-mono py-4 text-center">Loading songs from database...</div>';
  modal.classList.remove('hidden');

  fetch('/api/projects/')
    .then(res => {
      if (!res.ok) throw new Error('Failed to fetch songs');
      return res.json();
    })
    .then(data => {
      list.innerHTML = '';
      if (!data.projects || !data.projects.length) {
        list.innerHTML = '<div class="text-xs text-zinc-500 font-mono py-6 text-center">No saved songs found in database.</div>';
        return;
      }

      data.projects.forEach(p => {
        const row = document.createElement('div');
        const isCurrent = (State.projectId && State.projectId === p.id);
        row.className = `flex items-center justify-between p-2.5 rounded border transition ${
          isCurrent 
            ? 'bg-amber-400/10 border-amber-400/80' 
            : 'bg-zinc-950 border-zinc-800 hover:border-amber-400/50'
        }`;

        row.innerHTML = `
          <div class="flex flex-col gap-0.5 cursor-pointer flex-1 mr-2" data-action="load">
            <div class="text-xs font-mono font-bold text-white uppercase flex items-center gap-2">
              <span>${p.title || 'UNTITLED PROJECT'}</span>
              ${isCurrent ? '<span class="text-[9px] bg-amber-400 text-black px-1.5 py-0.2 rounded font-black">CURRENT</span>' : ''}
            </div>
            <div class="text-[10px] font-mono text-zinc-400">
              Key: <span class="text-amber-300 font-bold">${p.default_key}</span> • 
              <span>${Math.round(p.bpm)} BPM</span> • 
              <span>${p.total_measures} Bars</span>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <button type="button" class="btn-load-song px-3 py-1 text-[11px] font-mono font-bold bg-amber-400 hover:bg-amber-300 text-black rounded transition">
              Load
            </button>
            <button type="button" class="btn-delete-song p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-900 rounded border border-transparent hover:border-zinc-800 transition flex items-center justify-center cursor-pointer" title="Delete Song">
              <i class="ph-bold ph-trash text-sm pointer-events-none"></i>
            </button>
          </div>
        `;

        const loadSong = () => {
          window.location.href = `/${p.id}/`;
        };
        row.querySelector('[data-action="load"]').onclick = loadSong;
        row.querySelector('.btn-load-song').onclick = loadSong;

        const delBtn = row.querySelector('.btn-delete-song');
        if (delBtn) {
          delBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!confirm(`Permanently delete "${p.title || 'Song'}" and return to clean root?`)) return;

            try {
              if (typeof clearAudioFromDB === 'function') {
                await clearAudioFromDB(p.id);
                if (State.projectId === p.id) {
                  await clearAudioFromDB(null);
                }
              }
              sessionStorage.removeItem(`syncstage_tp_${p.id}`);
            } catch (err) {}

            if (State.projectId === p.id) {
              sessionStorage.removeItem('syncstage_tp_root');
              window.location.href = `/api/project/${p.id}/delete/`;
            } else {
              try {
                const resp = await fetch(`/api/project/${p.id}/delete/`, {
                  method: 'POST',
                  headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRFToken': getCookie('csrftoken') || ''
                  }
                });
                if (resp.ok) {
                  row.remove();
                  showToast(`Deleted "${p.title || 'Song'}"`);
                } else {
                  window.location.href = `/api/project/${p.id}/delete/`;
                }
              } catch (err) {
                window.location.href = `/api/project/${p.id}/delete/`;
              }
            }
          };
        }

        list.appendChild(row);
      });
    })
    .catch(err => {
      console.error(err);
      list.innerHTML = '<div class="text-xs text-red-400 font-mono py-4 text-center">Error loading saved songs.</div>';
    });
}

function getCookie(name) {
  let cookieValue = null;
  if (document.cookie && document.cookie !== '') {
    const cookies = document.cookie.split(';');
    for (let i = 0; i < cookies.length; i++) {
      const c = cookies[i].trim();
      if (c.startsWith(name + '=')) {
        cookieValue = decodeURIComponent(c.substring(name.length + 1));
        break;
      }
    }
  }
  return cookieValue;
}

/**
 * Prompts the user with a sleek studio modal for the project PIN.
 * Returns a Promise that resolves with the entered PIN, or rejects if cancelled.
 */
function promptProjectPin(showError = false) {
  return new Promise((resolve, reject) => {
    const modal = document.getElementById('pin-auth-modal');
    const input = document.getElementById('pin-auth-input');
    const submitBtn = document.getElementById('btn-pin-auth-submit');
    const cancelBtn = document.getElementById('btn-pin-auth-cancel');
    const errorEl = document.getElementById('pin-auth-error');

    if (!modal || !input) {
      const fallback = prompt("🔒 Project is protected. Enter edit PIN:");
      return fallback ? resolve(fallback) : reject(new Error("Canceled"));
    }

    if (errorEl) errorEl.classList.toggle('hidden', !showError);
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 60);

    const cleanup = () => {
      modal.classList.add('hidden');
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
    };

    const handleConfirm = () => {
      const val = input.value.trim();
      if (!val) {
        input.focus();
        return;
      }
      cleanup();
      resolve(val);
    };

    const handleCancel = () => {
      cleanup();
      reject(new Error("PIN entry cancelled"));
    };

    submitBtn.onclick = handleConfirm;
    cancelBtn.onclick = handleCancel;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') handleConfirm();
      if (e.key === 'Escape') handleCancel();
    };
  });
}

function saveProject() {
  const saveBtn = document.getElementById('btn-save-project') || document.getElementById('btn-export-project');
  if (saveBtn) saveBtn.disabled = true;

  const sortedSections = [...State.sections].sort((a, b) => a.startBar - b.startBar);
  const pinInput = document.getElementById('edit-song-pin');
  const enteredNewPin = pinInput ? pinInput.value.trim() : null;

  const payload = {
    title: State.song.title,
    key: State.song.key,
    bpm: State.timingPoints[0]?.bpm || 120,
    beatsPerBar: State.timingPoints[0]?.beatsPerBar || 4,
    timingPoints: State.timingPoints,
    totalMeasures: State.song.totalMeasures,
    pin: currentProjectPin,
    ...(enteredNewPin !== null && enteredNewPin !== "" ? { setPin: enteredNewPin } : {}),
    sections: sortedSections.map((s, idx) => {
      const nextSec = sortedSections[idx + 1];
      const endBar = nextSec ? Math.max(s.startBar, nextSec.startBar - 1) : State.song.totalMeasures;
      return {
        name: s.name,
        startBar: s.startBar,
        endBar: endBar,
        color: s.color || "#facc15",
        isNewSong: !!s.isNewSong,
        songTitle: s.songTitle || s.name,
        songKey: s.songKey || State.song.key
      };
    }),
    measures: State.measures.map(m => ({
      bar: m.bar,
      barIndex: m.bar,
      chordLine: m.chordLine || "",
      leadLine: m.leadLine || ""
    }))
  };

  const endpoint = State.projectId 
    ? `/api/project/${State.projectId}/save/` 
    : `/api/project/save/`;

  let uploadFile = currentAudioFile;
  if (!uploadFile && window.currentAudioRawBuffer && !backendData.audioUrl) {
    try {
      uploadFile = new File([window.currentAudioRawBuffer], window.currentAudioFileName || "audio_track.mp3", { type: "audio/mpeg" });
    } catch (e) {
      uploadFile = new Blob([window.currentAudioRawBuffer], { type: "audio/mpeg" });
    }
  }

  let requestBody;
  let requestHeaders = {
    'X-CSRFToken': getCookie('csrftoken') || ''
  };

  if (uploadFile) {
    const formData = new FormData();
    formData.append('project_data', JSON.stringify(payload));
    formData.append('audio_file', uploadFile, window.currentAudioFileName || "audio_track.mp3");
    requestBody = formData;
  } else {
    requestHeaders['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(payload);
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: requestHeaders,
    body: requestBody
  })
  .then(async response => {
    if (response.status === 403) {
      try {
        const pin = await promptProjectPin(currentProjectPin !== null);
        currentProjectPin = pin;
        return saveProject();
      } catch (err) {
        showToast("Save cancelled: PIN required");
      }
      return null;
    }

    if (!response.ok) throw new Error("HTTP error " + response.status);
    return response.json();
  })
  .then(data => {
    if (!data) return null;
    if (data.projectId) {
      State.projectId = data.projectId;
      try {
        sessionStorage.setItem(`syncstage_tp_${data.projectId}`, JSON.stringify(State.timingPoints));
      } catch (e) {}
      window.history.replaceState({}, '', `/${data.projectId}/`);
    }
    if (data.audioUrl) {
      backendData.audioUrl = data.audioUrl;
    }
    if (window.currentAudioRawBuffer && data.projectId && typeof saveAudioToDB === 'function') {
      saveAudioToDB(window.currentAudioRawBuffer, window.currentAudioFileName || "audio.mp3", data.projectId);
    }
    currentAudioFile = null;
    if (typeof getProjectSnapshot === 'function') {
      lastSavedSnapshot = getProjectSnapshot();
    }
    showToast("Project saved to Database!");
    return data;
  })
  .catch(err => {
    console.error("Save error:", err);
    showToast("Error saving to database");
    return null;
  })
  .finally(() => {
    if (saveBtn) saveBtn.disabled = false;
  });
}

/* =========================================================================
   PROJECT IMPORT / EXPORT ENGINE (.JSON)
   ========================================================================= */

function exportProjectToFile() {
  const sortedSections = [...State.sections].sort((a, b) => a.startBar - b.startBar);

  const exportPayload = {
    syncstage_version: "2.0",
    exported_at: new Date().toISOString(),
    song: {
      title: State.song.title || "UNTITLED PROJECT",
      key: State.song.key || "C",
      totalMeasures: State.song.totalMeasures || 8
    },
    timingPoints: State.timingPoints && State.timingPoints.length ? State.timingPoints : [
      { id: 1, offset: 0.0, bpm: 120.0, beatsPerBar: 4 }
    ],
    sections: sortedSections.map((s, idx) => {
      const nextSec = sortedSections[idx + 1];
      const endBar = nextSec ? Math.max(s.startBar, nextSec.startBar - 1) : State.song.totalMeasures;
      return {
        id: s.id || (idx + 1),
        startBar: s.startBar,
        endBar: endBar,
        name: s.name || `Section ${idx + 1}`,
        color: s.color || "#facc15",
        isNewSong: !!s.isNewSong,
        songTitle: s.songTitle || s.name,
        songKey: s.songKey || State.song.key
      };
    }),
    measures: State.measures.map((m, idx) => ({
      bar: m.bar || (idx + 1),
      barIndex: m.bar || (idx + 1),
      chordLine: m.chordLine || "",
      leadLine: m.leadLine || ""
    }))
  };

  const jsonString = JSON.stringify(exportPayload, null, 2);
  const blob = new Blob([jsonString], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  
  const sanitizeName = (State.song.title || "syncstage_project")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_');

  const downloadAnchor = document.createElement('a');
  downloadAnchor.href = url;
  downloadAnchor.download = `${sanitizeName}.json`;
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  URL.revokeObjectURL(url);

  showToast("Project exported (.json)");
}

function importProjectFromFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);

      if (!data.song && !data.measures && !data.sections) {
        throw new Error("Invalid SyncStage project format.");
      }

      if (data.song) {
        State.song.title = (data.song.title || "UNTITLED PROJECT").toUpperCase();
        State.song.key = (data.song.key || "C").toUpperCase();
        State.song.totalMeasures = Math.max(2, parseInt(data.song.totalMeasures, 10) || 8);
      } else if (data.title) {
        State.song.title = data.title.toUpperCase();
        State.song.key = (data.key || "C").toUpperCase();
        State.song.totalMeasures = Math.max(2, parseInt(data.totalMeasures, 10) || 8);
      }

      const titleInput = document.getElementById('edit-song-title');
      const keyInput = document.getElementById('edit-song-key');
      const totalMeasuresInput = document.getElementById('edit-total-measures');
      if (titleInput) titleInput.value = State.song.title;
      if (keyInput) keyInput.value = State.song.key;
      if (totalMeasuresInput) totalMeasuresInput.value = State.song.totalMeasures;

      if (Array.isArray(data.timingPoints) && data.timingPoints.length > 0) {
        State.timingPoints = data.timingPoints.map((tp, idx) => ({
          id: tp.id || (idx + 1),
          offset: parseFloat(tp.offset) || 0.0,
          bpm: parseFloat(tp.bpm) || 120.0,
          beatsPerBar: parseInt(tp.beatsPerBar, 10) || 4
        }));
      }

      if (Array.isArray(data.sections) && data.sections.length > 0) {
        State.sections = data.sections.map((sec, idx) => ({
          id: sec.id || Date.now() + idx,
          startBar: Math.max(1, parseInt(sec.startBar, 10) || 1),
          name: sec.name || `Section ${idx + 1}`,
          color: sec.color || "#facc15",
          isNewSong: !!sec.isNewSong,
          songTitle: sec.songTitle || sec.name,
          songKey: sec.songKey || State.song.key
        }));
        State.selectedSectionId = State.sections[0].id;
      }

      const hasMedleySongs = State.sections.filter(s => s.isNewSong).length > 1;
      State.isMedleyMode = hasMedleySongs;
      const medleyToggle = document.getElementById('toggle-medley-mode');
      if (medleyToggle) medleyToggle.checked = hasMedleySongs;

      if (Array.isArray(data.measures)) {
        State.measures = data.measures.map((m, idx) => ({
          bar: parseInt(m.bar || m.barIndex, 10) || (idx + 1),
          chordLine: m.chordLine || "",
          leadLine: m.leadLine || ""
        }));
      }

      while (State.measures.length < State.song.totalMeasures) {
        State.measures.push({ bar: State.measures.length + 1, chordLine: "", leadLine: "" });
      }

      if (State.isPlaying) AudioEngine.pause();
      seekToTime(0);
      updateEngine();

      saveProject();
      showToast(`Imported "${State.song.title}"`);
    } catch (err) {
      console.error("Import error:", err);
      alert("Failed to import project. Please ensure it is a valid SyncStage .json file.");
    }
  };
  reader.readAsText(file);
}

/* =========================================================================
   9. MAIN ANIMATION LOOP & DOM INITIALIZATION
   ========================================================================= */
let lastActiveBar = -1;
let lastScrubSecond = -1;

function animationLoop() {
  if (State.isPlaying) {
    State.currentTime = AudioEngine.getClockTime();
    if (State.currentTime >= State.totalDuration) {
      if (State.loopBar) seekToBar(State.loopTargetBar);
      else {
        AudioEngine.pause();
        seekToTime(0);
      }
    }
  }

  const metrics = getTimingMetricsAt(State.currentTime);
  State.currentGlobalBar = metrics.globalBarIndex;
  State.currentBeat = metrics.currentBeatInBar;

  if (metrics.globalBarIndex !== lastActiveBar) {
    lastActiveBar = metrics.globalBarIndex;
    updateHeaderDisplay(metrics);
    renderOverviewTimeline();
  }

  const curScrubSec = Math.floor(State.currentTime * 10);
  if (curScrubSec !== lastScrubSecond) {
    lastScrubSecond = curScrubSec;
    updateScrubberUI();
  }

  if (typeof Visualizer !== 'undefined' && Visualizer.draw) {
    Visualizer.draw();
  }
  requestAnimationFrame(animationLoop);
}

/* =========================================================================
   DOM CONTENT LOADED (EVENT REGISTRATION)
   ========================================================================= */

window.addEventListener('DOMContentLoaded', () => {
  const canvasEl = document.getElementById('stage-canvas');
  if (canvasEl && typeof Visualizer !== 'undefined') {
    Visualizer.init(canvasEl);
  }

  // If the loaded project is protected, show a locked placeholder
  const pinInput = document.getElementById('edit-song-pin');
  if (pinInput && State.isLocked) {
    pinInput.placeholder = "●●●● (Protected)";
  }

  // Open Saved Songs Library Modal bindings
  const btnOpenLib = document.getElementById('btn-open-library');
  const btnCloseLib = document.getElementById('btn-close-library-modal');
  const modalLib = document.getElementById('project-library-modal');

  if (btnOpenLib) {
    btnOpenLib.onclick = (e) => {
      e.preventDefault();
      openSongLibrary();
    };
  }

  if (btnCloseLib && modalLib) {
    btnCloseLib.onclick = () => modalLib.classList.add('hidden');
  }

  // Transport controls
  const playBtn = document.getElementById('btn-play');
  if (playBtn) {
    playBtn.onclick = (e) => {
      e.preventDefault();
      if (State.isPlaying) AudioEngine.pause();
      else AudioEngine.start(State.currentTime);
    };
  }

  const stopBtn = document.getElementById('btn-stop');
  if (stopBtn) {
    stopBtn.onclick = (e) => {
      e.preventDefault();
      AudioEngine.pause();
      seekToTime(0);
    };
  }

  const scrubber = document.getElementById('timeline-scrubber');
  if (scrubber) {
    scrubber.oninput = (e) => seekToTime(parseFloat(e.target.value));
  }

  const prevBarBtn = document.getElementById('btn-prev-bar');
  if (prevBarBtn) {
    prevBarBtn.onclick = () => seekToBar(Math.max(1, State.currentGlobalBar - 1));
  }

  const nextBarBtn = document.getElementById('btn-next-bar');
  if (nextBarBtn) {
    nextBarBtn.onclick = () => seekToBar(Math.min(State.song.totalMeasures, State.currentGlobalBar + 1));
  }

  // Loop Bar
  const loopBarBtn = document.getElementById('btn-loop-bar');
  if (loopBarBtn) {
    loopBarBtn.onclick = () => {
      State.loopBar = !State.loopBar;
      State.loopTargetBar = State.currentGlobalBar;
      const lbl = document.getElementById('loop-state-text');
      if (State.loopBar) {
        if (lbl) lbl.textContent = `Loop Bar: #${State.loopTargetBar}`;
        loopBarBtn.classList.add('bg-amber-400/20', 'border-amber-400', 'text-amber-300');
      } else {
        if (lbl) lbl.textContent = 'Loop Bar: OFF';
        loopBarBtn.classList.remove('bg-amber-400/20', 'border-amber-400', 'text-amber-300');
      }
    };
  }

  // Faders & Click
  const musicVol = document.getElementById('music-vol');
  if (musicVol) {
    musicVol.oninput = (e) => AudioEngine.setMusicVolume(parseFloat(e.target.value));
  }

  const metronomeVol = document.getElementById('metronome-vol');
  if (metronomeVol) {
    metronomeVol.oninput = (e) => AudioEngine.setClickVolume(parseFloat(e.target.value));
  }

  const metronomeToggle = document.getElementById('metronome-toggle');
  if (metronomeToggle) {
    metronomeToggle.onchange = (e) => {
      State.metronomeEnabled = e.target.checked;
      AudioEngine.setClickVolume(State.metronomeVolume);
    };
  }

  // Tap Tempo
  const tapTimes = [];
  const tapTempoBtn = document.getElementById('btn-tap-tempo');
  if (tapTempoBtn) {
    tapTempoBtn.onclick = () => {
      const now = performance.now();
      tapTimes.push(now);
      if (tapTimes.length > 5) tapTimes.shift();
      if (tapTimes.length >= 2) {
        const diffs = [];
        for (let i = 1; i < tapTimes.length; i++) diffs.push(tapTimes[i] - tapTimes[i - 1]);
        const avgMs = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const bpm = Math.round(60000 / avgMs);
        const metrics = getTimingMetricsAt(State.currentTime);
        metrics.activePoint.bpm = bpm;
        tapTempoBtn.textContent = `${bpm} BPM!`;
        setTimeout(() => { tapTempoBtn.textContent = "TAP TEMPO"; }, 1500);
        updateEngine();
      }
    };
  }

  // Batch Selection
  const masterSelectChk = document.getElementById('chk-master-select-all');
  if (masterSelectChk) {
    masterSelectChk.onchange = (e) => {
      if (e.target.checked) {
        for (let b = 1; b <= State.song.totalMeasures; b++) State.selectedBars.add(b);
      } else {
        State.selectedBars.clear();
      }
      updateSelectionUI();
      renderMeasuresEditor();
    };
  }

  const clearSelectionBtn = document.getElementById('btn-batch-clear-selection');
  if (clearSelectionBtn) {
    clearSelectionBtn.onclick = () => {
      State.selectedBars.clear();
      updateSelectionUI();
      renderMeasuresEditor();
    };
  }

  const copySelectedBtn = document.getElementById('btn-batch-copy-selected');
  if (copySelectedBtn) {
    copySelectedBtn.onclick = () => {
      const selected = Array.from(State.selectedBars).sort((a, b) => a - b);
      if (!selected.length) return;
      State.multiBarClipboard = selected.map(b => ({
        chordLine: State.measures[b - 1]?.chordLine || '',
        leadLine: State.measures[b - 1]?.leadLine || ''
      }));
      showToast(`Copied ${selected.length} selected bars`);
    };
  }

  const pasteAtBtn = document.getElementById('btn-batch-paste-at');
  if (pasteAtBtn) {
    pasteAtBtn.onclick = () => {
      if (!State.multiBarClipboard) return;
      const destBarInput = document.getElementById('batch-paste-dest-bar');
      const destBar = parseInt(destBarInput?.value, 10) || 1;
      State.multiBarClipboard.forEach((item, idx) => {
        const t = (destBar - 1) + idx;
        if (t < State.measures.length) {
          State.measures[t].chordLine = item.chordLine;
          State.measures[t].leadLine = item.leadLine;
        }
      });
      updateEngine();
      showToast(`Pasted bars starting at Bar ${destBar}`);
    };
  }

  // Global Transpose
  const trDownBtn = document.getElementById('btn-transpose-down');
  if (trDownBtn) trDownBtn.onclick = () => transposeEntireProject(-1);

  const trUpBtn = document.getElementById('btn-transpose-up');
  if (trUpBtn) trUpBtn.onclick = () => transposeEntireProject(1);

  const editSongTitle = document.getElementById('edit-song-title');
  if (editSongTitle) {
    editSongTitle.oninput = (e) => {
      State.song.title = e.target.value.toUpperCase();
      const visTitle = document.getElementById('vis-title');
      if (visTitle) visTitle.textContent = State.song.title;
    };
  }

  const editSongKey = document.getElementById('edit-song-key');
  if (editSongKey) {
    editSongKey.onchange = (e) => {
      State.song.key = e.target.value.toUpperCase();
      const visKey = document.getElementById('vis-key');
      if (visKey) visKey.textContent = State.song.key;
    };
  }

  const editTotalMeasures = document.getElementById('edit-total-measures');
  if (editTotalMeasures) {
    editTotalMeasures.onchange = (e) => {
      State.song.totalMeasures = Math.max(2, parseInt(e.target.value, 10) || 8);
      updateEngine();
    };
  }

  // Tab switching
  ['timing', 'sections', 'chords'].forEach(t => {
    const btn = document.getElementById(`tab-${t}-btn`);
    if (btn) {
      btn.onclick = () => {
        ['timing', 'sections', 'chords'].forEach(other => {
          const panel = document.getElementById(`tab-${other}-panel`);
          const otherBtn = document.getElementById(`tab-${other}-btn`);
          if (panel) panel.classList.toggle('hidden', other !== t);
          if (otherBtn) {
            otherBtn.className = other === t
              ? "flex-1 py-1.5 text-amber-400 border-b-2 border-amber-400 flex items-center justify-center gap-1.5"
              : "flex-1 py-1.5 text-zinc-400 hover:text-zinc-200 border-b-2 border-transparent flex items-center justify-center gap-1.5";
          }
        });
      };
    }
  });

  // Section additions
  const addSecBtn = document.getElementById('btn-add-section');
  if (addSecBtn) {
    addSecBtn.onclick = () => {
      State.sections.push({
        id: Date.now(),
        startBar: State.currentGlobalBar || 1,
        name: `Section ${State.sections.length + 1}`,
        color: '#facc15',
        isNewSong: false,
        songKey: State.song.key
      });
      updateEngine();
    };
  }

  // Quick section buttons
  document.querySelectorAll('.btn-quick-sec').forEach(btn => {
    btn.onclick = () => {
      const name = btn.getAttribute('data-name');
      const p = getSongPalette(0);
      State.sections.push({
        id: Date.now(),
        startBar: State.currentGlobalBar || 1,
        name: name,
        color: getSectionColorFromPalette(p, name),
        isNewSong: false,
        songKey: State.song.key
      });
      updateEngine();
    };
  });

  const btnNewSong = document.getElementById('btn-quick-new-song');
  if (btnNewSong) {
    btnNewSong.onclick = () => {
      const songsCount = State.sections.filter(s => s.isNewSong).length;
      const p = getSongPalette(songsCount + 1);
      State.sections.push({
        id: Date.now(),
        startBar: State.currentGlobalBar || 1,
        name: "Intro",
        color: p.intro,
        isNewSong: true,
        songTitle: "NEW SONG TITLE",
        songKey: State.song.key
      });
      if (!State.isMedleyMode) {
        State.isMedleyMode = true;
        const medChk = document.getElementById('toggle-medley-mode');
        if (medChk) medChk.checked = true;
      }
      updateEngine();
    };
  }

  const demoMedleyBtn = document.getElementById('btn-demo-medley');
  if (demoMedleyBtn) {
    demoMedleyBtn.onclick = () => {
      State.isMedleyMode = true;
      const medChk = document.getElementById('toggle-medley-mode');
      if (medChk) medChk.checked = true;

      State.song.totalMeasures = 32;
      const totalMeasuresIn = document.getElementById('edit-total-measures');
      if (totalMeasuresIn) totalMeasuresIn.value = 32;

      State.sections = [
        { id: 1, startBar: 1, name: "Intro", color: "#facc15", isNewSong: true, songTitle: "SONG 1 (IN D)", songKey: "D" },
        { id: 2, startBar: 5, name: "Chorus", color: "#fbbf24", isNewSong: false, songKey: "D" },
        { id: 3, startBar: 17, name: "Bridge", color: "#38bdf8", isNewSong: true, songTitle: "SONG 2 (IN G)", songKey: "G" },
        { id: 4, startBar: 25, name: "Outro", color: "#0284c7", isNewSong: false, songKey: "G" }
      ];
      updateEngine();
      showToast("Loaded Demo Medley!");
    };
  }

  // Timing Points Tab buttons
  const btnAddTiming = document.getElementById('btn-add-timing');
  if (btnAddTiming) {
    btnAddTiming.onclick = () => {
      const lastTp = State.timingPoints[State.timingPoints.length - 1] || { bpm: 120, beatsPerBar: 4 };
      State.timingPoints.push({
        id: Date.now(),
        offset: Math.round(State.currentTime * 1000) / 1000,
        bpm: lastTp.bpm,
        beatsPerBar: lastTp.beatsPerBar
      });
      State.timingPoints.sort((a, b) => a.offset - b.offset);
      try {
        sessionStorage.setItem(`syncstage_tp_${State.projectId || 'root'}`, JSON.stringify(State.timingPoints));
      } catch (err) {}
      updateEngine();
      showToast("Added timing point");
    };
  }

  const btnStampTiming = document.getElementById('btn-stamp-timing');
  if (btnStampTiming) {
    btnStampTiming.onclick = () => {
      const metrics = getTimingMetricsAt(State.currentTime);
      metrics.activePoint.offset = Math.round(State.currentTime * 1000) / 1000;
      State.timingPoints.sort((a, b) => a.offset - b.offset);
      try {
        sessionStorage.setItem(`syncstage_tp_${State.projectId || 'root'}`, JSON.stringify(State.timingPoints));
      } catch (err) {}
      updateEngine();
      showToast(`Stamped offset: ${metrics.activePoint.offset.toFixed(3)}s`);
    };
  }

  const btnDemoOsu = document.getElementById('btn-demo-osu');
  if (btnDemoOsu) {
    btnDemoOsu.onclick = () => {
      State.timingPoints = [
        { id: 1, offset: 0.500, bpm: 130, beatsPerBar: 4 },
        { id: 2, offset: 37.423, bpm: 130, beatsPerBar: 4 }
      ];
      try {
        sessionStorage.setItem(`syncstage_tp_${State.projectId || 'root'}`, JSON.stringify(State.timingPoints));
      } catch (err) {}
      updateEngine();
      showToast("Loaded demo timing points (0.500s offset, 130 BPM)");
    };
  }

  const btnDemo34 = document.getElementById('btn-demo-34');
  if (btnDemo34) {
    btnDemo34.onclick = () => {
      State.timingPoints.push({
        id: Date.now(),
        offset: Math.round(State.currentTime * 1000) / 1000,
        bpm: State.timingPoints[0]?.bpm || 120,
        beatsPerBar: 3
      });
      State.timingPoints.sort((a, b) => a.offset - b.offset);
      try {
        sessionStorage.setItem(`syncstage_tp_${State.projectId || 'root'}`, JSON.stringify(State.timingPoints));
      } catch (err) {}
      updateEngine();
      showToast("Added 3/4 meter timing point");
    };
  }

  // Save to Database button
  const saveBtn = document.getElementById('btn-save-project');
  if (saveBtn) {
    saveBtn.onclick = (e) => {
      e.preventDefault();
      saveProject();
    };
  }

  // Export to .JSON button
  const exportBtn = document.getElementById('btn-export-project');
  if (exportBtn) {
    exportBtn.onclick = (e) => {
      e.preventDefault();
      exportProjectToFile();
    };
  }

  // Import from .JSON file input
  const projectFileInput = document.getElementById('project-file-input');
  if (projectFileInput) {
    projectFileInput.onchange = (e) => {
      if (e.target.files && e.target.files[0]) {
        importProjectFromFile(e.target.files[0]);
        e.target.value = '';
      }
    };
  }

  // OSU File & Paste modal
  const osuFileInput = document.getElementById('osu-file-input');
  if (osuFileInput) {
    osuFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = (evt) => {
        const parsed = parseOsuBeatmap(evt.target.result);
        if (parsed) {
          applyParsedOsuBeatmap(parsed);
          showToast("Parsed .osu beatmap!");
        }
      };
      r.readAsText(file);
    };
  }

  const pasteModal = document.getElementById('paste-osu-modal');
  const btnPasteOsuModal = document.getElementById('btn-paste-osu-modal');
  if (btnPasteOsuModal && pasteModal) {
    btnPasteOsuModal.onclick = () => pasteModal.classList.remove('hidden');
  }

  const btnClosePasteModal = document.getElementById('btn-close-paste-modal');
  if (btnClosePasteModal && pasteModal) {
    btnClosePasteModal.onclick = () => pasteModal.classList.add('hidden');
  }

  const btnCancelPaste = document.getElementById('btn-cancel-paste');
  if (btnCancelPaste && pasteModal) {
    btnCancelPaste.onclick = () => pasteModal.classList.add('hidden');
  }

  const btnParsePastedOsu = document.getElementById('btn-parse-pasted-osu');
  if (btnParsePastedOsu && pasteModal) {
    btnParsePastedOsu.onclick = () => {
      const textarea = document.getElementById('paste-osu-textarea');
      const parsed = parseOsuBeatmap(textarea?.value || '');
      if (parsed) {
        applyParsedOsuBeatmap(parsed);
        pasteModal.classList.add('hidden');
        showToast("Parsed .osu content!");
      }
    };
  }

  // Audio file load
  const audioFileInput = document.getElementById('audio-file-input');
  if (audioFileInput) {
    audioFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      currentAudioFile = file;
      window.currentAudioFileName = file.name;
      const r = new FileReader();
      r.onload = (evt) => {
        window.currentAudioRawBuffer = evt.target.result.slice(0);
        saveAudioToDB(window.currentAudioRawBuffer, file.name, State.projectId);
        saveAudioToDB(window.currentAudioRawBuffer, file.name, null);

        AudioEngine.init().decodeAudioData(evt.target.result, (buf) => {
          State.audioBuffer = buf;
          recalculateTotalDuration();
          const audioLbl = document.getElementById('audio-filename-lbl');
          const audioIcon = document.getElementById('audio-status-icon');
          if (audioLbl) audioLbl.textContent = file.name.length > 12 ? file.name.substring(0, 10) + '...' : file.name;
          if (audioIcon) audioIcon.className = "ph-bold ph-check-circle text-sm text-green-400";
          
          State.currentTime = 0;
          State.songPlaybackOffset = 0;
          State.currentGlobalBar = 1;
          State.currentBeat = 1;
          seekToTime(0);
          updateScrubberBounds();
          updateEngine();
        });

        // If project already exists on backend, upload immediately in background
        if (State.projectId) {
          const fd = new FormData();
          fd.append('audio_file', file);
          fetch(`/api/project/${State.projectId}/upload-audio/`, {
            method: 'POST',
            headers: {
              'X-CSRFToken': getCookie('csrftoken') || ''
            },
            body: fd
          })
          .then(res => res.json())
          .then(data => {
            if (data && data.audioUrl) {
              backendData.audioUrl = data.audioUrl;
              currentAudioFile = null;
              showToast("Audio track saved to project!");
            }
          })
          .catch(err => {
            console.warn("Background audio upload error:", err);
          });
        }
      };
      r.readAsArrayBuffer(file);
    };
  }

  // New Project / Clean Slate Studio System
  const newProjectModal = document.getElementById('new-project-modal') || document.getElementById('trash-warning-modal');
  const btnCancelNewProject = document.getElementById('btn-cancel-new-project') || document.getElementById('btn-cancel-trash');
  const btnDiscardNewProject = document.getElementById('btn-discard-new-project') || document.getElementById('btn-confirm-trash-discard');
  const btnSaveNewProject = document.getElementById('btn-save-new-project') || document.getElementById('btn-confirm-trash-save');
  const btnNewProject = document.getElementById('btn-new-project') || document.getElementById('btn-trash-project');
  const btnClearAudio = document.getElementById('btn-clear-audio');

  function openNewProjectModal() {
    if (!newProjectModal) {
      if (hasUnsavedChanges()) {
        if (confirm("Warning: You have unsaved progress that will be gone. Start a new project anyway?")) {
          cleanSlateWorkspace();
        }
      } else {
        cleanSlateWorkspace();
      }
      return;
    }

    const isUnsaved = hasUnsavedChanges();
    const modalTitle = document.getElementById('new-project-modal-title') || document.getElementById('trash-modal-title');
    const modalDesc = document.getElementById('new-project-modal-desc') || document.getElementById('trash-modal-desc');
    const modalSubdesc = document.getElementById('new-project-modal-subdesc') || document.getElementById('trash-modal-subdesc');
    const iconContainer = document.getElementById('new-project-icon-container') || document.getElementById('trash-modal-icon-container');
    const icon = document.getElementById('new-project-icon') || document.getElementById('trash-modal-icon');
    const btnDiscard = document.getElementById('btn-discard-new-project') || document.getElementById('btn-confirm-trash-discard');
    const btnSave = document.getElementById('btn-save-new-project') || document.getElementById('btn-confirm-trash-save');

    if (isUnsaved) {
      if (modalTitle) modalTitle.textContent = "Warning: Unsaved Progress";
      if (modalDesc) modalDesc.textContent = "Your current project has unsaved changes. If you start a new project without saving, this progress will be gone. Would you like to save it to your library first, or start a new project anyway?";
      if (modalSubdesc) modalSubdesc.textContent = "Saved projects in your library will remain safe.";
      if (iconContainer) {
        iconContainer.className = "w-10 h-10 rounded-lg bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400 shrink-0 mt-0.5";
      }
      if (icon) icon.className = "ph-bold ph-warning text-2xl";
      if (btnDiscard) {
        btnDiscard.textContent = "Discard & Start New";
        btnDiscard.className = "px-3 py-1.5 rounded-md text-xs font-mono font-semibold text-red-400 hover:text-white bg-red-950/40 hover:bg-red-600/80 border border-red-500/40 transition";
      }
      if (btnSave) {
        btnSave.classList.remove('hidden');
      }
    } else {
      if (modalTitle) modalTitle.textContent = "Start New Project";
      if (modalDesc) modalDesc.textContent = State.projectId
        ? "Your current project is saved in your library and can be reopened anytime. Start a new clean project?"
        : "Reset the studio workspace to a clean slate to start a new project.";
      if (modalSubdesc) modalSubdesc.textContent = "Your saved projects in the library will remain safe.";
      if (iconContainer) {
        iconContainer.className = "w-10 h-10 rounded-lg bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400 shrink-0 mt-0.5";
      }
      if (icon) icon.className = "ph-bold ph-file-plus text-2xl";
      if (btnDiscard) {
        btnDiscard.textContent = "Start New Project";
        btnDiscard.className = "px-4 py-1.5 rounded-md text-xs font-mono font-bold text-black bg-amber-400 hover:bg-amber-300 transition shadow-lg shadow-amber-400/20";
      }
      if (btnSave) {
        btnSave.classList.add('hidden');
      }
    }

    newProjectModal.classList.remove('hidden');
  }

  function closeNewProjectModal() {
    if (newProjectModal) newProjectModal.classList.add('hidden');
  }

  if (btnNewProject) {
    btnNewProject.onclick = (e) => {
      e.preventDefault();
      openNewProjectModal();
    };
  }

  // Audio track remove button (only clears audio, does NOT touch the project!)
  if (btnClearAudio) {
    btnClearAudio.onclick = async (e) => {
      e.preventDefault();
      AudioEngine.pause();
      AudioEngine.stopAudioSource();
      State.audioBuffer = null;
      backendData.audioUrl = null;

      try {
        if (typeof clearAudioFromDB === 'function') {
          await clearAudioFromDB(State.projectId);
          await clearAudioFromDB(null);
        }
      } catch (e) {}

      if (audioFileInput) audioFileInput.value = '';
      const audioLbl = document.getElementById('audio-filename-lbl');
      const audioIcon = document.getElementById('audio-status-icon');
      if (audioLbl) audioLbl.textContent = 'Load Audio';
      if (audioIcon) audioIcon.className = 'ph ph-upload-simple text-sm text-amber-400';
      btnClearAudio.classList.add('hidden');
      recalculateTotalDuration();
      seekToTime(0);
      updateEngine();
      showToast("Audio track removed");
    };
  }

  if (btnCancelNewProject) {
    btnCancelNewProject.onclick = (e) => {
      e.preventDefault();
      closeNewProjectModal();
    };
  }

  if (btnDiscardNewProject) {
    btnDiscardNewProject.onclick = async (e) => {
      e.preventDefault();
      closeNewProjectModal();
      await cleanSlateWorkspace();
    };
  }

  if (btnSaveNewProject) {
    btnSaveNewProject.onclick = async (e) => {
      e.preventDefault();
      const saved = await saveProject();
      if (saved) {
        closeNewProjectModal();
        await cleanSlateWorkspace();
      }
    };
  }

  if (newProjectModal) {
    newProjectModal.onclick = (e) => {
      if (e.target === newProjectModal) closeNewProjectModal();
    };
  }

  async function cleanSlateWorkspace() {
    // 1. Exit stage/video presentation mode if active
    if (State.isVideoMode && typeof exitStageMode === 'function') {
      exitStageMode();
    }

    // 2. Stop and reset audio playback
    if (typeof AudioEngine !== 'undefined') {
      try {
        AudioEngine.pause();
        AudioEngine.stopAudioSource();
      } catch (e) {}
    }
    State.isPlaying = false;
    State.audioBuffer = null;
    currentAudioFile = null;
    window.currentAudioFileName = null;
    window.currentAudioRawBuffer = null;
    State.currentTime = 0;
    State.songPlaybackOffset = 0;
    State.currentGlobalBar = 1;
    State.currentBeat = 1;
    State.loopBar = false;
    State.loopTargetBar = 1;
    backendData.audioUrl = null;

    // 3. Reset project ID to null (clean root studio, NOT deleting project from DB!)
    State.projectId = null;
    State.isLocked = false;
    currentProjectPin = null;

    // 4. Wipe temporary session storage & root audio cache
    try {
      sessionStorage.removeItem('syncstage_tp_root');
      if (typeof clearAudioFromDB === 'function') {
        await clearAudioFromDB(null);
      }
    } catch (err) {}

    // 5. Reset song metadata to clean defaults
    State.song = {
      title: "UNTITLED PROJECT",
      key: "C",
      totalMeasures: 8
    };

    // 6. Reset sections (wipes all medley songs & extra sections in studio)
    State.isMedleyMode = false;
    State.sections = [
      {
        id: 1,
        startBar: 1,
        name: "Section 1",
        color: "#facc15",
        isNewSong: true,
        songTitle: "UNTITLED PROJECT",
        songKey: "C"
      }
    ];
    State.selectedSectionId = 1;
    State.collapsedSections.clear();
    State.collapsedSongs.clear();

    // 7. Reset timing points to clean default single timing point
    State.timingPoints = [
      {
        id: 1,
        offset: 0.0,
        bpm: 120.0,
        beatsPerBar: 4
      }
    ];

    // 8. Wipe ALL measures / chords (no chords, no leads in studio)
    State.measures = [];
    for (let i = 1; i <= State.song.totalMeasures; i++) {
      State.measures.push({ bar: i, chordLine: "", leadLine: "" });
    }

    // 9. Reset multi-bar selection & clipboard
    State.selectedBars.clear();
    State.multiBarClipboard = null;

    // 10. Reset all UI inputs & labels
    const titleInput = document.getElementById('edit-song-title');
    if (titleInput) titleInput.value = State.song.title;

    const keyInput = document.getElementById('edit-song-key');
    if (keyInput) keyInput.value = State.song.key;

    const totalMeasuresInput = document.getElementById('edit-total-measures');
    if (totalMeasuresInput) totalMeasuresInput.value = State.song.totalMeasures;

    const pinInput = document.getElementById('edit-song-pin');
    if (pinInput) pinInput.value = '';

    const medleyToggle = document.getElementById('toggle-medley-mode');
    if (medleyToggle) medleyToggle.checked = false;

    const audioFileInput = document.getElementById('audio-file-input');
    if (audioFileInput) audioFileInput.value = '';

    const audioLbl = document.getElementById('audio-filename-lbl');
    if (audioLbl) audioLbl.textContent = 'Load Audio';

    const audioIcon = document.getElementById('audio-status-icon');
    if (audioIcon) audioIcon.className = 'ph ph-upload-simple text-sm text-amber-400';

    if (btnClearAudio) btnClearAudio.classList.add('hidden');

    const osuFileInput = document.getElementById('osu-file-input');
    if (osuFileInput) osuFileInput.value = '';

    const osuFilenameLbl = document.getElementById('osu-filename-lbl');
    if (osuFilenameLbl) osuFilenameLbl.textContent = 'Import .osu';

    const pasteOsuText = document.getElementById('paste-osu-textarea');
    if (pasteOsuText) pasteOsuText.value = '';

    const batchCountLbl = document.getElementById('batch-selection-count-lbl');
    if (batchCountLbl) batchCountLbl.textContent = '0 bars selected';

    const masterSelectAllChk = document.getElementById('chk-master-select-all');
    if (masterSelectAllChk) {
      masterSelectAllChk.checked = false;
      masterSelectAllChk.indeterminate = false;
    }

    const batchClipStatus = document.getElementById('batch-clipboard-status');
    if (batchClipStatus) batchClipStatus.textContent = 'clipboard empty';

    const btnPlayText = document.getElementById('btn-play-text');
    const btnPlayIcon = document.getElementById('btn-play-icon');
    if (btnPlayText) btnPlayText.textContent = 'PLAY';
    if (btnPlayIcon) btnPlayIcon.className = 'ph-fill ph-play text-base';

    const stagePlayText = document.getElementById('stage-play-text');
    const stagePlayIcon = document.getElementById('stage-play-icon');
    if (stagePlayText) stagePlayText.textContent = 'Play';
    if (stagePlayIcon) stagePlayIcon.className = 'ph-fill ph-play text-sm';

    const loopText = document.getElementById('loop-state-text');
    if (loopText) loopText.textContent = 'Loop Bar: OFF';

    // 11. Clean browser URL to /
    if (window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/');
    }

    // 12. Full engine & canvas re-render
    recalculateTotalDuration();
    seekToTime(0);
    updateEngine();
    updateScrubberBounds();
    updateScrubberUI();
    updateSelectedSectionUI();

    if (typeof Visualizer !== 'undefined' && Visualizer.draw) {
      Visualizer.draw();
    }

    lastSavedSnapshot = getProjectSnapshot();
    showToast("New project started.");
  }

  window.openNewProjectModal = openNewProjectModal;
  window.closeNewProjectModal = closeNewProjectModal;
  window.openTrashModal = openNewProjectModal;
  window.closeTrashModal = closeNewProjectModal;
  window.cleanSlateWorkspace = cleanSlateWorkspace;
  window.wipeEntireWorkspace = cleanSlateWorkspace;

  // Settings Modal
  const settingsModal = document.getElementById('settings-modal');
  const btnOpenSettings = document.getElementById('btn-open-settings-modal');
  if (btnOpenSettings && settingsModal) {
    btnOpenSettings.onclick = () => settingsModal.classList.remove('hidden');
  }

  const btnCloseSettings = document.getElementById('btn-close-settings-modal');
  if (btnCloseSettings && settingsModal) {
    btnCloseSettings.onclick = () => settingsModal.classList.add('hidden');
  }

  const btnSaveSettings = document.getElementById('btn-save-settings');
  if (btnSaveSettings && settingsModal) {
    btnSaveSettings.onclick = () => {
      const sel = document.querySelector('input[name="opt-layout-mode"]:checked');
      if (sel) State.settings.layoutMode = sel.value;
      const beat4Ghost = document.getElementById('chk-beat4-ghost');
      if (beat4Ghost) State.settings.beat4Ghosting = beat4Ghost.checked;
      const rangeOpacity = document.getElementById('range-preview-opacity');
      if (rangeOpacity) State.settings.previewOpacity = parseFloat(rangeOpacity.value) || 0.50;
      const spectrumWave = document.getElementById('chk-spectrum-wave');
      if (spectrumWave) State.settings.showSpectrum = spectrumWave.checked;
      const rangeIntensity = document.getElementById('range-spectrum-intensity');
      if (rangeIntensity) State.settings.spectrumIntensity = parseFloat(rangeIntensity.value) || 0.70;
      settingsModal.classList.add('hidden');
    };
  }

  const rangePreviewOpacity = document.getElementById('range-preview-opacity');
  if (rangePreviewOpacity) {
    rangePreviewOpacity.oninput = (e) => {
      const opacityVal = document.getElementById('preview-opacity-val');
      if (opacityVal) opacityVal.textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
    };
  }

  const rangeSpectrumIntensity = document.getElementById('range-spectrum-intensity');
  if (rangeSpectrumIntensity) {
    rangeSpectrumIntensity.oninput = (e) => {
      const intensityVal = document.getElementById('spectrum-intensity-val');
      if (intensityVal) intensityVal.textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
    };
  }

  // Stage Mode toggles
  const btnVideoMode = document.getElementById('btn-video-mode');
  if (btnVideoMode) btnVideoMode.onclick = enterStageMode;

  const btnExitVideo = document.getElementById('btn-exit-video');
  if (btnExitVideo) btnExitVideo.onclick = exitStageMode;

  const btnStageEditor = document.getElementById('btn-stage-editor');
  if (btnStageEditor) btnStageEditor.onclick = toggleStageDrawer;

  const btnStagePlay = document.getElementById('btn-stage-play');
  if (btnStagePlay) {
    btnStagePlay.onclick = () => {
      if (State.isPlaying) AudioEngine.pause();
      else AudioEngine.start(State.currentTime);
    };
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && State.isVideoMode) exitStageMode();
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (State.isPlaying) AudioEngine.pause();
      else AudioEngine.start(State.currentTime);
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      if (State.isVideoMode) exitStageMode();
      else enterStageMode();
    } else if (e.code === 'Escape') {
      const modal = document.getElementById('new-project-modal') || document.getElementById('trash-warning-modal');
      if (modal && !modal.classList.contains('hidden')) {
        closeNewProjectModal();
        return;
      }
      if (State.isVideoMode) exitStageMode();
    } else if (e.code === 'ArrowLeft') {
      seekToTime(State.currentTime - 1);
    } else if (e.code === 'ArrowRight') {
      seekToTime(State.currentTime + 1);
    }
  });

  // Initialize UI & Components
  setupPresetRenameButtons();
  setupTimelineTooltip();
  
  State.currentTime = 0;
  State.songPlaybackOffset = 0;
  State.currentGlobalBar = 1;
  State.currentBeat = 1;

  updateEngine();
  seekToTime(0);

  async function initAudioTrack() {
    try {
      await restoreCachedAudio();
    } catch (e) {
      console.warn("restoreCachedAudio error:", e);
    }

    if (!State.audioBuffer && backendData.audioUrl) {
      try {
        const res = await fetch(backendData.audioUrl);
        if (res.ok) {
          const bufData = await res.arrayBuffer();
          const cleanName = decodeURIComponent(backendData.audioUrl.split('/').pop() || "Audio Track");
          window.currentAudioRawBuffer = bufData.slice(0);
          window.currentAudioFileName = cleanName;
          if (typeof saveAudioToDB === 'function') {
            saveAudioToDB(bufData.slice(0), cleanName, State.projectId);
          }
          AudioEngine.init().decodeAudioData(bufData, (buf) => {
            State.audioBuffer = buf;
            recalculateTotalDuration();
            const audioLbl = document.getElementById('audio-filename-lbl');
            const audioIcon = document.getElementById('audio-status-icon');
            if (audioLbl) audioLbl.textContent = cleanName.length > 12 ? cleanName.substring(0, 10) + '...' : cleanName;
            if (audioIcon) audioIcon.className = "ph-bold ph-check-circle text-sm text-green-400";
            updateScrubberBounds();
            updateEngine();
          });
        }
      } catch (e) {
        console.warn("Backend audioUrl fetch failed:", e);
      }
    }
  }

  initAudioTrack();

  requestAnimationFrame(animationLoop);
});