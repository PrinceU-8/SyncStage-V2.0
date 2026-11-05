/* =========================================================================
   SYNCSTAGE AUDIO & TIMING ENGINE WITH LOOKAHEAD METRONOME SCHEDULER
   ========================================================================= */

const AudioEngine = {
  clickGainNode: null,
  lastScheduledSongTime: -1,
  activeClicks: [],
  scheduleAheadTime: 0.12, // seconds to look ahead
  lookaheadInterval: 25,   // ms between schedule cycles
  schedulerTimerId: null,

  init() {
    if (!State.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      State.audioCtx = new AudioCtxClass();

      // Master music pipeline & analyzer
      State.audioGainNode = State.audioCtx.createGain();
      State.audioGainNode.gain.value = State.musicVolume;

      State.analyserNode = State.audioCtx.createAnalyser();
      State.analyserNode.fftSize = 128;
      State.spectrumFreqData = new Uint8Array(State.analyserNode.frequencyBinCount);

      State.audioGainNode.connect(State.analyserNode);
      State.analyserNode.connect(State.audioCtx.destination);

      // Metronome click master bus
      this.clickGainNode = State.audioCtx.createGain();
      this.clickGainNode.gain.value = State.metronomeEnabled ? State.metronomeVolume : 0;
      this.clickGainNode.connect(State.audioCtx.destination);
    }
    return State.audioCtx;
  },

  getNextBeatSongTime(afterSongTime) {
    let points = (typeof getSortedTimingPoints === 'function') 
      ? getSortedTimingPoints() 
      : (State.timingPoints || [{ id: 1, offset: 0, bpm: 120, beatsPerBar: 4 }]);
    if (!points || !points.length) {
      points = [{ id: 1, offset: 0, bpm: 120, beatsPerBar: 4 }];
    }

    // Clean duplicate offsets if any
    const cleanPoints = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].offset > cleanPoints[cleanPoints.length - 1].offset + 1e-4) {
        cleanPoints.push(points[i]);
      }
    }

    // If before the very first timing point
    if (afterSongTime < cleanPoints[0].offset - 1e-4) {
      return cleanPoints[0].offset;
    }

    // Find active timing point index
    let activeIdx = 0;
    for (let i = 0; i < cleanPoints.length; i++) {
      if (afterSongTime >= cleanPoints[i].offset - 1e-4) {
        activeIdx = i;
      } else {
        break;
      }
    }

    const curTp = cleanPoints[activeIdx];
    const nextTp = cleanPoints[activeIdx + 1];
    const secPerBeat = 60 / (curTp.bpm || 120);

    const timeSinceTp = Math.max(0, afterSongTime - curTp.offset);
    const beatsPassed = Math.floor((timeSinceTp + 1e-4) / secPerBeat);
    let candidateBeat = curTp.offset + (beatsPassed + 1) * secPerBeat;

    // Check if next timing point begins at or before candidate beat
    if (nextTp && nextTp.offset <= candidateBeat + 1e-4) {
      if (nextTp.offset > afterSongTime + 1e-4) {
        return nextTp.offset;
      } else {
        const nextSecPerBeat = 60 / (nextTp.bpm || 120);
        return nextTp.offset + nextSecPerBeat;
      }
    }

    if (candidateBeat <= afterSongTime + 1e-4) {
      candidateBeat = afterSongTime + secPerBeat;
    }

    return candidateBeat;
  },

  async start(startTime = 0) {
    this.init();

    if (State.audioCtx.state === 'suspended') {
      try {
        await State.audioCtx.resume();
      } catch (e) {
        console.warn("AudioContext resume failed:", e);
      }
    }

    this.stopAudioSource();
    this.stopScheduler();
    this.cancelScheduledClicks();

    const targetOffset = Math.max(0, startTime);
    State.audioCtxStartTime = State.audioCtx.currentTime;
    State.songPlaybackOffset = targetOffset;

    if (State.audioBuffer) {
      State.audioSource = State.audioCtx.createBufferSource();
      State.audioSource.buffer = State.audioBuffer;
      State.audioSource.connect(State.audioGainNode);
      if (targetOffset < State.audioBuffer.duration) {
        State.audioSource.start(0, targetOffset);
      }
    }

    // Check if targetOffset is on or within 45ms of a beat
    const metrics = getTimingMetricsAt(targetOffset);
    const activeTp = metrics.activePoint;
    const secPerBeat = 60 / (activeTp.bpm || 120);
    const timeSinceTp = targetOffset - (activeTp.offset || 0);

    if (timeSinceTp <= 0) {
      if (Math.abs(timeSinceTp) < 0.05) {
        this.lastScheduledSongTime = activeTp.offset;
        if (State.metronomeEnabled) {
          this.playClick(State.audioCtx.currentTime, true);
        }
      } else {
        this.lastScheduledSongTime = targetOffset - 0.001;
      }
    } else {
      const beatsPassed = timeSinceTp / secPerBeat;
      const fraction = beatsPassed % 1;
      if (fraction < 0.05 || (1 - fraction) * secPerBeat < 0.04) {
        const hitBeatTime = activeTp.offset + Math.round(beatsPassed) * secPerBeat;
        this.lastScheduledSongTime = hitBeatTime;
        if (State.metronomeEnabled) {
          this.playClick(State.audioCtx.currentTime, metrics.currentBeatInBar === 1);
        }
      } else {
        this.lastScheduledSongTime = targetOffset - 0.001;
      }
    }

    State.isPlaying = true;
    this.updatePlayButtonUI(true);

    this.startScheduler();
    this.scheduleClicks();
  },

  pause() {
    this.stopAudioSource();
    this.stopScheduler();
    this.cancelScheduledClicks();

    if (State.audioCtx) {
      const elapsed = Math.max(0, State.audioCtx.currentTime - State.audioCtxStartTime);
      State.currentTime = Math.max(0, State.songPlaybackOffset + elapsed);
    }

    State.isPlaying = false;
    this.updatePlayButtonUI(false);
  },

  cancelScheduledClicks() {
    if (this.activeClicks && this.activeClicks.length > 0) {
      const now = State.audioCtx ? State.audioCtx.currentTime : 0;
      for (let c of this.activeClicks) {
        if (c.time > now) {
          try {
            c.gain.gain.cancelScheduledValues(now);
            c.gain.gain.setValueAtTime(0, now);
            c.osc.stop(now);
          } catch (e) {}
        }
      }
      this.activeClicks = [];
    }
  },

  resync() {
    if (!State.isPlaying || !State.audioCtx) return;

    this.cancelScheduledClicks();
    const currentSongTime = this.getClockTime();
    this.lastScheduledSongTime = currentSongTime - 0.001;
    this.scheduleClicks();
  },

  stopAudioSource() {
    if (State.audioSource) {
      try {
        State.audioSource.stop();
        State.audioSource.disconnect();
      } catch (e) {}
      State.audioSource = null;
    }
  },

  startScheduler() {
    if (this.schedulerTimerId) clearInterval(this.schedulerTimerId);
    this.schedulerTimerId = setInterval(() => this.scheduleClicks(), this.lookaheadInterval);
  },

  stopScheduler() {
    if (this.schedulerTimerId) {
      clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
  },

  scheduleClicks() {
    if (!State.isPlaying || !State.audioCtx) return;

    const currentSongTime = this.getClockTime();
    const maxSongTime = currentSongTime + this.scheduleAheadTime;

    // Safety guard against tab sleep / large jumps
    if (this.lastScheduledSongTime < currentSongTime - 0.5) {
      this.lastScheduledSongTime = currentSongTime - 0.05;
    }

    let nextBeatSong = this.getNextBeatSongTime(this.lastScheduledSongTime);

    while (nextBeatSong <= maxSongTime) {
      const audioCtxTime = State.audioCtxStartTime + (nextBeatSong - State.songPlaybackOffset);
      const playTime = Math.max(audioCtxTime, State.audioCtx.currentTime);

      const metrics = getTimingMetricsAt(nextBeatSong + 0.005);
      const isDownbeat = (metrics.currentBeatInBar === 1);

      if (State.metronomeEnabled) {
        this.playClick(playTime, isDownbeat);
      }

      this.lastScheduledSongTime = nextBeatSong;
      const followingBeat = this.getNextBeatSongTime(nextBeatSong);
      if (followingBeat <= nextBeatSong + 1e-4) {
        break; // Guard against loop
      }
      nextBeatSong = followingBeat;
    }
  },

  playClick(time, isDownbeat = false) {
    if (!State.audioCtx || !this.clickGainNode) return;

    const playTime = Math.max(time, State.audioCtx.currentTime);
    const osc = State.audioCtx.createOscillator();
    const gain = State.audioCtx.createGain();

    // High accent on Beat 1 (1600Hz), mid click on others (880Hz)
    osc.frequency.setValueAtTime(isDownbeat ? 1600 : 880, playTime);
    osc.type = 'triangle';

    gain.gain.setValueAtTime(1.0, playTime);
    gain.gain.exponentialRampToValueAtTime(0.001, playTime + 0.04);

    osc.connect(gain);
    gain.connect(this.clickGainNode);

    osc.start(playTime);
    osc.stop(playTime + 0.045);

    if (!this.activeClicks) this.activeClicks = [];
    const record = { osc, gain, time: playTime };
    this.activeClicks.push(record);
    osc.onended = () => {
      const idx = this.activeClicks.indexOf(record);
      if (idx !== -1) this.activeClicks.splice(idx, 1);
    };
  },

  getClockTime() {
    if (!State.isPlaying || !State.audioCtx) {
      return State.currentTime;
    }
    const elapsed = Math.max(0, State.audioCtx.currentTime - State.audioCtxStartTime);
    return Math.max(0, State.songPlaybackOffset + elapsed);
  },

  setMusicVolume(vol) {
    State.musicVolume = vol;
    if (State.audioGainNode) {
      State.audioGainNode.gain.value = vol;
    }
  },

  setClickVolume(vol) {
    State.metronomeVolume = vol;
    if (this.clickGainNode) {
      this.clickGainNode.gain.value = State.metronomeEnabled ? vol : 0;
    }
  },

  updatePlayButtonUI(isPlaying) {
    const playBtnText = document.getElementById('btn-play-text');
    const playBtnIcon = document.getElementById('btn-play-icon');
    const stagePlayText = document.getElementById('stage-play-text');
    const stagePlayIcon = document.getElementById('stage-play-icon');

    if (playBtnText) playBtnText.textContent = isPlaying ? 'PAUSE' : 'PLAY';
    if (playBtnIcon) {
      playBtnIcon.className = isPlaying ? 'ph-fill ph-pause text-base' : 'ph-fill ph-play text-base';
    }

    if (stagePlayText) stagePlayText.textContent = isPlaying ? 'Pause' : 'Play';
    if (stagePlayIcon) {
      stagePlayIcon.className = isPlaying ? 'ph-fill ph-pause text-sm' : 'ph-fill ph-play text-sm';
    }
  }
};


/* =========================================================================
   INDEXEDDB PERSISTENT AUDIO CACHE WITH PROJECT ISOLATION
   ========================================================================= */

function getAudioDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("SyncStageDB", 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("audioStore")) {
        db.createObjectStore("audioStore", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAudioToDB(arrayBuffer, filename, projectId = null) {
  try {
    const db = await getAudioDB();
    const tx = db.transaction("audioStore", "readwrite");
    const store = tx.objectStore("audioStore");
    const targetKey = projectId ? `audio_project_${projectId}` : "cached_audio";

    store.put({
      id: targetKey,
      projectId: projectId || null,
      data: arrayBuffer,
      name: filename,
      savedAt: Date.now()
    });

    if (projectId) {
      store.put({
        id: "cached_audio",
        projectId: projectId,
        data: arrayBuffer,
        name: filename,
        savedAt: Date.now()
      });
    }
  } catch (err) {
    console.warn("IndexedDB save failed:", err);
  }
}

async function clearAudioFromDB(projectId = null) {
  try {
    const db = await getAudioDB();
    const tx = db.transaction("audioStore", "readwrite");
    const store = tx.objectStore("audioStore");
    if (projectId) {
      store.delete(`audio_project_${projectId}`);
    }
    store.delete("cached_audio");
  } catch (err) {
    console.warn("IndexedDB clear failed:", err);
  }
}

async function restoreCachedAudio() {
  try {
    const currentPid = State.projectId;
    const db = await getAudioDB();
    const tx = db.transaction("audioStore", "readonly");
    const store = tx.objectStore("audioStore");

    const searchKey = currentPid ? `audio_project_${currentPid}` : "cached_audio";
    const getReq = store.get(searchKey);

    getReq.onsuccess = () => {
      let record = getReq.result;

      if (!record && currentPid) {
        const fallbackReq = store.get("cached_audio");
        fallbackReq.onsuccess = () => {
          const fbRecord = fallbackReq.result;
          if (fbRecord && fbRecord.data && fbRecord.projectId == currentPid) {
            applyAudioRecord(fbRecord);
          }
        };
        return;
      }

      if (!currentPid && record && record.projectId) {
        return;
      }

      if (record && record.data) {
        applyAudioRecord(record);
      }
    };
  } catch (err) {
    console.warn("IndexedDB restore error:", err);
  }
}

function applyAudioRecord(item) {
  const filename = item.name || "audio.mp3";
  AudioEngine.init().decodeAudioData(item.data.slice(0), (buf) => {
    State.audioBuffer = buf;

    const audioLbl = document.getElementById('audio-filename-lbl');
    const audioIcon = document.getElementById('audio-status-icon');
    const clearAudioBtn = document.getElementById('btn-clear-audio');
    if (audioLbl) audioLbl.textContent = filename.length > 12 ? filename.substring(0, 10) + '...' : filename;
    if (audioIcon) audioIcon.className = "ph-bold ph-check-circle text-sm text-green-400";
    if (clearAudioBtn) clearAudioBtn.classList.remove('hidden');

    State.currentTime = 0;
    State.songPlaybackOffset = 0;
    State.currentGlobalBar = 1;
    State.currentBeat = 1;
    recalculateTotalDuration();
    seekToTime(0);
    updateEngine();
  }, (decodeErr) => {
    console.warn("Cached audio decode failed:", decodeErr);
  });
}
