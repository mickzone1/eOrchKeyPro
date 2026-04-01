'use strict';

/* ═══════════════════════════════════════════════════════════════
   eOrchKey — main.js
   Audio engine: Tone.js 14.x (CDN)

   Architecture:
   ┌─────────────────────────────────────────────────────────┐
   │  State (plain object) ──► recomputePitches()            │
   │  AudioEngine (Tone.js) ── PolySynth → Filter → Reverb   │
   │  Gesture layer ────────── PointerEvents on each key btn  │
   │  Scale Engine ─────────── root + scale → note array     │
   └─────────────────────────────────────────────────────────┘
   ═══════════════════════════════════════════════════════════════ */


// ─── Scale Engine ────────────────────────────────────────────────

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

const SCALE_INTERVALS = {
  chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  microtonal: null, // user-defined cents array
};

/**
 * Build an array of pitch objects for the button grid.
 * For microtonal mode, intervals are in cents (100 = 1 semitone).
 * Returns: [{ note: string, freq: number, label: string }]
 */
function getButtonPitches(root, octave, scaleType, count, microtonalCents) {
  if (scaleType === 'microtonal') {
    const baseFreq = Tone.Frequency(root + octave).toFrequency();
    return microtonalCents.slice(0, count).map((cents) => {
      const freq = baseFreq * Math.pow(2, cents / 1200);
      // Find nearest chromatic note for PolySynth tracking
      const midiExact = 69 + 12 * Math.log2(freq / 440);
      const midiRound = Math.round(midiExact);
      const note = Tone.Frequency(midiRound, 'midi').toNote();
      const detuneOffset = (midiExact - midiRound) * 100; // cents from nearest note
      return { note, freq, label: (cents % 1200 === 0 ? root : `+${cents.toFixed(0)}¢`), detuneOffset };
    });
  }

  const intervals = SCALE_INTERVALS[scaleType] || SCALE_INTERVALS.major;
  const rootIdx = NOTE_NAMES.indexOf(root);
  const pitches = [];
  let i = 0;

  while (pitches.length < count) {
    const interval = intervals[i % intervals.length];
    const octShift = Math.floor(i / intervals.length);
    const absIdx = rootIdx + interval;
    const noteIdx = ((absIdx % 12) + 12) % 12;
    const noteOct = octave + octShift + Math.floor(absIdx / 12);
    const noteStr = NOTE_NAMES[noteIdx] + noteOct;
    const freq = Tone.Frequency(noteStr).toFrequency();
    pitches.push({ note: noteStr, freq, label: noteStr, detuneOffset: 0 });
    i++;
  }

  return pitches.slice(0, count);
}


// ─── Keyboard Mapping ────────────────────────────────────────────

/**
 * Default key codes (e.KeyboardEvent.code) for buttons 0–7.
 * Buttons 0-3: arrow keys, 4: space, 5-7: digit keys.
 */
const DEFAULT_KEY_MAP = [
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Space', 'Digit1', 'Digit2', 'Digit3',
];

/** Human-readable short labels for display on buttons and in the editor. */
const KEY_DISPLAY = {
  ArrowLeft: '←', ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓',
  Space: 'SPC',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
};
function keyDisplayLabel(code) {
  if (KEY_DISPLAY[code]) return KEY_DISPLAY[code];
  // KeyA → A, BracketLeft → [, etc.
  return code.replace(/^Key/, '').replace(/^Numpad/, 'N').slice(0, 5);
}

/** Currently pressed keyboard keys (code → buttonIndex, prevents repeat). */
const heldKeys = new Map(); // code → buttonIndex

/** Index of the button row currently listening for a remap, or -1. */
let remapTarget = -1;


// ─── Application State ───────────────────────────────────────────

const state = {
  instrument: 'piano',
  buttonCount: 6,
  pitchMode: 'scale',
  scale: { root: 'C', octave: 4, type: 'pentatonic' },
  manualPitches: ['C4', 'E4', 'G4', 'A4', 'C5', 'E5', 'G5', 'A5'],
  microtonalIntervals: [0, 150, 300, 450, 600, 750, 900, 1050],
  gestureSensitivity: { y: 1.0, x: 1.0 },
  fmParams: {
    attack: 0.01,
    decay: 0.3,
    sustain: 0.5,
    release: 0.8,
    modulationIndex: 3,
    harmonicity: 1.5,
  },
  keyMap: [...DEFAULT_KEY_MAP],  // mutable copy, saved with presets
  computedPitches: [],           // [{ note, freq, label, detuneOffset }]
};

function recomputePitches() {
  if (state.pitchMode === 'scale') {
    state.computedPitches = getButtonPitches(
      state.scale.root,
      state.scale.octave,
      state.scale.type,
      state.buttonCount,
      state.microtonalIntervals,
    );
  } else {
    // Manual mode — validate each entry
    state.computedPitches = state.manualPitches
      .slice(0, state.buttonCount)
      .map((n) => {
        try {
          const freq = Tone.Frequency(n).toFrequency();
          return { note: n, freq, label: n, detuneOffset: 0 };
        } catch {
          // Fallback to C4 if invalid note string
          return { note: 'C4', freq: 261.63, label: n + '?', detuneOffset: 0 };
        }
      });
  }
}


// ─── Audio Engine ────────────────────────────────────────────────

let engine = null;

class AudioEngine {
  constructor() {
    // Effects chain: PolySynth → LowpassFilter → Freeverb → Destination
    this.reverb = new Tone.Freeverb({ roomSize: 0.35, dampening: 3500, wet: 0.18 });
    this.filter = new Tone.Filter({ frequency: 5000, type: 'lowpass', Q: 0.8 });
    this.filter.connect(this.reverb);
    this.reverb.toDestination();

    this.synth = null;
    this._defaultFilterFreq = 5000;
    this._buildSynth(state.instrument);
  }

  _buildSynth(type) {
    // Cleanly dispose the previous synth
    if (this.synth) {
      try { this.synth.releaseAll(); } catch (_) {}
      this.synth.disconnect();
      this.synth.dispose();
      this.synth = null;
    }

    const PRESETS = {
      // Piano — triangle-based PolySynth with percussive decay
      piano: () => new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle8' },
        envelope: { attack: 0.005, decay: 1.4, sustain: 0.0, release: 0.9 },
        volume: -4,
      }),

      // Flute — FM synth, sine-on-sine, slow attack, long sustain
      flute: () => new Tone.PolySynth(Tone.FMSynth, {
        modulationIndex: 3,
        harmonicity: 3.01,
        oscillator: { type: 'sine' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.14, decay: 0.2, sustain: 0.88, release: 1.0 },
        modulationEnvelope: { attack: 0.5, decay: 0.1, sustain: 0.8, release: 0.3 },
        volume: -6,
      }),

      // Vibraphone — FM with high modulation index → metallic bell tone, no sustain
      vibraphone: () => new Tone.PolySynth(Tone.FMSynth, {
        modulationIndex: 14,
        harmonicity: 3.5,
        oscillator: { type: 'sine' },
        modulation: { type: 'square' },
        envelope: { attack: 0.001, decay: 2.5, sustain: 0.0, release: 0.6 },
        modulationEnvelope: { attack: 0.001, decay: 0.6, sustain: 0.0, release: 0.1 },
        volume: -5,
      }),

      // Custom FM Synth — fully user-configurable
      fmSynth: () => new Tone.PolySynth(Tone.FMSynth, {
        modulationIndex: state.fmParams.modulationIndex,
        harmonicity: state.fmParams.harmonicity,
        envelope: {
          attack: state.fmParams.attack,
          decay: state.fmParams.decay,
          sustain: state.fmParams.sustain,
          release: state.fmParams.release,
        },
        volume: -4,
      }),
    };

    this.synth = (PRESETS[type] ?? PRESETS.piano)();
    this.synth.connect(this.filter);
  }

  switchInstrument(type) {
    this._buildSynth(type);
  }

  /**
   * Update the FM Synth parameters live (no rebuild needed).
   * Only takes effect when instrument === 'fmSynth'.
   */
  updateFMParams() {
    if (state.instrument !== 'fmSynth' || !this.synth) return;
    this.synth.set({
      modulationIndex: state.fmParams.modulationIndex,
      harmonicity: state.fmParams.harmonicity,
      envelope: {
        attack: state.fmParams.attack,
        decay: state.fmParams.decay,
        sustain: state.fmParams.sustain,
        release: state.fmParams.release,
      },
    });
  }

  /**
   * @param {object} pitch  - { note: string, detuneOffset: number }
   * @param {number} velocity  - 0–1
   */
  triggerAttack(pitch, velocity = 0.7) {
    if (!this.synth || !pitch?.note) return;
    // Apply microtonal detuning before attack
    if (pitch.detuneOffset !== 0) {
      this.synth.set({ detune: Math.round(pitch.detuneOffset) });
    }
    try {
      this.synth.triggerAttack(pitch.note, Tone.now(), Math.max(0.05, Math.min(velocity, 1)));
    } catch (e) {
      console.warn('triggerAttack:', e.message);
    }
  }

  triggerRelease(pitch) {
    if (!this.synth || !pitch?.note) return;
    try {
      this.synth.triggerRelease(pitch.note, Tone.now());
    } catch (e) {
      console.warn('triggerRelease:', e.message);
    }
  }

  /** Y-axis gesture: open/close the lowpass filter */
  setFilterCutoff(hz) {
    this.filter.frequency.rampTo(
      Math.max(100, Math.min(hz, 18000)),
      0.05,
    );
  }

  /** X-axis gesture: pitch bend via detune (±cents) */
  setPitchBend(semitones) {
    if (!this.synth) return;
    try {
      this.synth.set({ detune: Math.round(semitones * 100) });
    } catch (_) {}
  }

  resetPitchBend() {
    if (!this.synth) return;
    try { this.synth.set({ detune: 0 }); } catch (_) {}
  }

  resetFilter() {
    this.filter.frequency.rampTo(this._defaultFilterFreq, 0.15);
  }

  dispose() {
    if (this.synth) this.synth.dispose();
    this.filter.dispose();
    this.reverb.dispose();
  }
}


// ─── Gesture State ───────────────────────────────────────────────

/** Map: pointerId → { keyIndex, pitch, originX, originY } */
const activePointers = new Map();

function mapRange(value, inMin, inMax, outMin, outMax) {
  const clamped = Math.max(inMin, Math.min(value, inMax));
  return outMin + ((clamped - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/**
 * Estimate velocity from PointerEvent contact geometry.
 * Falls back to 0.7 for mouse or when geometry is unavailable.
 */
function pointerVelocity(e) {
  const area = (e.width ?? 0) * (e.height ?? 0);
  if (area < 1) return 0.7; // mouse / stylus
  return Math.max(0.1, Math.min(area / 2800, 1));
}


// ─── Key Grid Rendering ──────────────────────────────────────────

function renderKeyGrid() {
  const grid = document.getElementById('keyGrid');
  grid.innerHTML = '';

  const isPortrait = window.innerHeight > window.innerWidth;
  const count = state.buttonCount;

  if (isPortrait && count > 4) {
    const cols = Math.ceil(count / 2);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = '1fr 1fr';
  } else {
    grid.style.gridTemplateColumns = `repeat(${count}, 1fr)`;
    grid.style.gridTemplateRows = '1fr';
  }

  state.computedPitches.forEach((pitch, idx) => {
    const btn = document.createElement('div');
    btn.className = 'key';
    btn.dataset.index = idx;
    const kbdCode = state.keyMap[idx];
    const kbdLabel = kbdCode ? keyDisplayLabel(kbdCode) : '';
    btn.innerHTML = `
      <div class="key-dot"></div>
      ${kbdLabel ? `<div class="key-kbd">${kbdLabel}</div>` : ''}
      <div class="key-note">${pitch.label}</div>
      <div class="key-freq">${Math.round(pitch.freq)} Hz</div>
    `;

    // ── Pointer Down ──
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);

      engine.triggerAttack(pitch, pointerVelocity(e));
      activePointers.set(e.pointerId, {
        keyIndex: idx,
        pitch,
        originX: e.clientX,
        originY: e.clientY,
      });
      btn.classList.add('active');
    }, { passive: false });

    // ── Pointer Move (gesture expressions) ──
    btn.addEventListener('pointermove', (e) => {
      const ptr = activePointers.get(e.pointerId);
      if (!ptr) return;

      // Y-axis (upward slide = more filter open)
      const dy = (ptr.originY - e.clientY) * state.gestureSensitivity.y;
      const cutoff = mapRange(dy, -220, 220, 180, 14000);
      engine.setFilterCutoff(cutoff);

      // X-axis (rightward slide = sharper pitch)
      const dx = (e.clientX - ptr.originX) * state.gestureSensitivity.x;
      const bend = mapRange(dx, -220, 220, -3, 3);
      engine.setPitchBend(bend);
    });

    // ── Pointer Up / Cancel ──
    const onRelease = (e) => {
      const ptr = activePointers.get(e.pointerId);
      if (!ptr) return;

      engine.triggerRelease(ptr.pitch);
      activePointers.delete(e.pointerId);
      btn.classList.remove('active');

      // Reset expression only when the last finger lifts
      if (activePointers.size === 0) {
        engine.resetPitchBend();
        engine.resetFilter();
      }
    };

    btn.addEventListener('pointerup', onRelease);
    btn.addEventListener('pointercancel', onRelease);

    grid.appendChild(btn);
  });
}


// ─── Keyboard Layer ──────────────────────────────────────────────

/** Reverse lookup: code → button index (rebuilt whenever keyMap changes). */
let codeToIndex = {};
function rebuildCodeIndex() {
  codeToIndex = {};
  state.keyMap.forEach((code, i) => { if (code) codeToIndex[code] = i; });
}

function keyButtonEl(idx) {
  return document.querySelector(`#keyGrid .key[data-index="${idx}"]`);
}

function initKeyboardLayer() {
  document.addEventListener('keydown', (e) => {
    // Never fire when typing inside an input or the drawer is capturing a remap
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // ── Remap capture mode ──
    if (remapTarget !== -1) {
      if (e.code === 'Escape') {
        cancelRemap();
      } else {
        commitRemap(e.code);
      }
      e.preventDefault();
      return;
    }

    const idx = codeToIndex[e.code];
    if (idx === undefined) return;
    if (heldKeys.has(e.code)) return;  // prevent key-repeat
    e.preventDefault();

    heldKeys.set(e.code, idx);
    const pitch = state.computedPitches[idx];
    if (!pitch) return;

    engine.triggerAttack(pitch, 0.7);
    keyButtonEl(idx)?.classList.add('active');
  });

  document.addEventListener('keyup', (e) => {
    if (remapTarget !== -1) return;
    const idx = heldKeys.get(e.code);
    if (idx === undefined) return;
    e.preventDefault();

    heldKeys.delete(e.code);
    const pitch = state.computedPitches[idx];
    if (pitch) engine.triggerRelease(pitch);
    keyButtonEl(idx)?.classList.remove('active');

    if (heldKeys.size === 0) {
      engine.resetPitchBend();
      engine.resetFilter();
    }
  });

  rebuildCodeIndex();
}

// ─── Key Remap UI ────────────────────────────────────────────────

function renderKeyMapRows() {
  const container = document.getElementById('keyMapRows');
  container.innerHTML = '';
  for (let i = 0; i < state.buttonCount; i++) {
    const pitch = state.computedPitches[i];
    const code  = state.keyMap[i] ?? '';
    const row = document.createElement('div');
    row.className = 'keymap-row';
    row.dataset.idx = i;
    row.innerHTML = `
      <span class="keymap-idx">${i + 1}</span>
      <span class="keymap-note">${pitch?.label ?? '—'}</span>
      <span class="keymap-key">${code ? keyDisplayLabel(code) : '—'}</span>
    `;
    row.addEventListener('click', () => startRemap(i));
    container.appendChild(row);
  }
}

function startRemap(idx) {
  cancelRemap(); // clear any previous
  remapTarget = idx;
  document.querySelectorAll('.keymap-row').forEach((r) => r.classList.remove('listening'));
  const row = document.querySelector(`.keymap-row[data-idx="${idx}"]`);
  if (row) {
    row.classList.add('listening');
    row.querySelector('.keymap-key').textContent = '?';
  }
  document.getElementById('keyMapHint').classList.remove('hidden');
}

function cancelRemap() {
  remapTarget = -1;
  document.querySelectorAll('.keymap-row').forEach((r) => r.classList.remove('listening'));
  document.getElementById('keyMapHint').classList.add('hidden');
}

function commitRemap(code) {
  const idx = remapTarget;
  cancelRemap();

  // Remove this code from any other slot
  state.keyMap = state.keyMap.map((c, i) => (c === code && i !== idx ? '' : c));
  state.keyMap[idx] = code;

  rebuildCodeIndex();
  renderKeyMapRows();
  renderKeyGrid(); // refresh kbd badges on the buttons
}


// ─── Settings UI Sync ────────────────────────────────────────────

function syncSettingsUI() {
  const BADGE = { piano: 'PIANO', flute: 'FLUTE', vibraphone: 'VIBES', fmSynth: 'FM SYNTH' };
  document.getElementById('instrumentBadge').textContent = BADGE[state.instrument] ?? 'SYNTH';

  // Sync select inputs to state (important after URL-load or preset-load)
  document.getElementById('keyCount').value  = state.buttonCount;
  document.getElementById('keyCountVal').textContent = state.buttonCount;
  document.getElementById('rootNote').value  = state.scale.root;
  document.getElementById('rootOctave').value = state.scale.octave;
  document.getElementById('microtonalIntervals').value = state.microtonalIntervals.join(', ');

  // Sync segmented controls
  const activateSeg = (id, value) => {
    document.querySelectorAll(`#${id} .seg-btn`).forEach((b) => {
      b.classList.toggle('active', b.dataset.value === value);
    });
  };
  activateSeg('instrumentPicker', state.instrument);
  activateSeg('pitchModePicker', state.pitchMode);
  activateSeg('scalePicker', state.scale.type);

  // Show/hide conditional panels
  document.getElementById('fmPanel').classList.toggle('hidden', state.instrument !== 'fmSynth');
  document.getElementById('scalePanel').classList.toggle('hidden', state.pitchMode !== 'scale');
  document.getElementById('manualPanel').classList.toggle('hidden', state.pitchMode !== 'manual');
  document.getElementById('microtonalPanel').classList.toggle('hidden', state.scale.type !== 'microtonal');

  renderManualPitchInputs();
  renderKeyMapRows();
}

function renderManualPitchInputs() {
  const container = document.getElementById('manualPitchInputs');
  container.innerHTML = '';
  for (let i = 0; i < state.buttonCount; i++) {
    const row = document.createElement('div');
    row.className = 'manual-row';
    const val = state.manualPitches[i] ?? 'C4';
    row.innerHTML = `
      <span class="manual-row-label">${i + 1}</span>
      <input type="text" class="manual-note-input" value="${val}" data-idx="${i}" />
    `;
    row.querySelector('input').addEventListener('change', (e) => {
      state.manualPitches[Number(e.target.dataset.idx)] = e.target.value.trim();
      recomputePitches();
      renderKeyGrid();
    });
    container.appendChild(row);
  }
}


// ─── Drawer ──────────────────────────────────────────────────────

function openSettings() {
  document.getElementById('settingsDrawer').classList.add('open');
  document.getElementById('drawerBackdrop').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsDrawer').classList.remove('open');
  document.getElementById('drawerBackdrop').classList.add('hidden');
}


// ─── Controls Initialisation ─────────────────────────────────────

function initControls() {
  document.getElementById('settingsBtn').onclick = openSettings;
  document.getElementById('closeDrawer').onclick = closeSettings;
  document.getElementById('drawerBackdrop').onclick = closeSettings;

  // ── Segmented helper ──
  function bindSegmented(containerId, onChange) {
    document.querySelectorAll(`#${containerId} .seg-btn`).forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${containerId} .seg-btn`).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(btn.dataset.value);
      });
    });
  }

  // ── Instrument picker ──
  bindSegmented('instrumentPicker', (value) => {
    state.instrument = value;
    engine.switchInstrument(value);
    syncSettingsUI();
  });

  // ── Key count ──
  const keyCountInput = document.getElementById('keyCount');
  const keyCountVal   = document.getElementById('keyCountVal');
  keyCountInput.addEventListener('input', () => {
    state.buttonCount = Number(keyCountInput.value);
    keyCountVal.textContent = state.buttonCount;
    recomputePitches();
    renderKeyGrid();
    renderManualPitchInputs();
    renderKeyMapRows();
  });

  // ── Pitch mode ──
  bindSegmented('pitchModePicker', (value) => {
    state.pitchMode = value;
    syncSettingsUI();
    recomputePitches();
    renderKeyGrid();
  });

  // ── Scale type ──
  bindSegmented('scalePicker', (value) => {
    state.scale.type = value;
    syncSettingsUI();
    recomputePitches();
    renderKeyGrid();
  });

  // ── Root note & octave ──
  document.getElementById('rootNote').addEventListener('change', (e) => {
    state.scale.root = e.target.value;
    recomputePitches();
    renderKeyGrid();
  });
  document.getElementById('rootOctave').addEventListener('change', (e) => {
    state.scale.octave = Number(e.target.value);
    recomputePitches();
    renderKeyGrid();
  });

  // ── Microtonal intervals ──
  document.getElementById('microtonalIntervals').addEventListener('change', (e) => {
    state.microtonalIntervals = e.target.value
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => !isNaN(n));
    if (state.scale.type === 'microtonal') {
      recomputePitches();
      renderKeyGrid();
    }
  });

  // ── Gesture sensitivity ──
  function bindRange(id, valId, statePath, decimals = 1) {
    const input = document.getElementById(id);
    const span  = document.getElementById(valId);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      statePath(v);
      span.textContent = v.toFixed(decimals);
    });
  }

  bindRange('ySens', 'ySensVal', (v) => { state.gestureSensitivity.y = v; });
  bindRange('xSens', 'xSensVal', (v) => { state.gestureSensitivity.x = v; });

  // ── FM synth params ──
  bindRange('modIndex',   'modIndexVal',   (v) => { state.fmParams.modulationIndex = v; engine.updateFMParams(); }, 1);
  bindRange('harmonicity','harmonicityVal',(v) => { state.fmParams.harmonicity = v;     engine.updateFMParams(); }, 1);
  bindRange('fmAttack',   'attackVal',     (v) => { state.fmParams.attack = v;          engine.updateFMParams(); }, 3);
  bindRange('fmDecay',    'decayVal',      (v) => { state.fmParams.decay = v;           engine.updateFMParams(); }, 2);
  bindRange('fmSustain',  'sustainVal',    (v) => { state.fmParams.sustain = v;         engine.updateFMParams(); }, 2);
  bindRange('fmRelease',  'releaseVal',    (v) => { state.fmParams.release = v;         engine.updateFMParams(); }, 2);

  // ── Preset: Save ──
  document.getElementById('btnSave').addEventListener('click', () => {
    const preset = {
      instrument:           state.instrument,
      buttonCount:          state.buttonCount,
      pitchMode:            state.pitchMode,
      scale:                { ...state.scale },
      manualPitches:        [...state.manualPitches],
      microtonalIntervals:  [...state.microtonalIntervals],
      gestureSensitivity:   { ...state.gestureSensitivity },
      fmParams:             { ...state.fmParams },
      keyMap:               [...state.keyMap],
    };
    localStorage.setItem('eOrchKeyPreset', JSON.stringify(preset));
    const btn = document.getElementById('btnSave');
    const prev = btn.textContent;
    btn.textContent = 'SAVED ✓';
    setTimeout(() => { btn.textContent = prev; }, 1600);
  });

  // ── Preset: Load ──
  document.getElementById('btnLoad').addEventListener('click', () => {
    const raw = localStorage.getItem('eOrchKeyPreset');
    if (!raw) return;
    try {
      const p = JSON.parse(raw);

      // Merge loaded values
      if (p.instrument)          state.instrument          = p.instrument;
      if (p.buttonCount)         state.buttonCount         = p.buttonCount;
      if (p.pitchMode)           state.pitchMode           = p.pitchMode;
      if (p.scale)               Object.assign(state.scale, p.scale);
      if (p.manualPitches)       state.manualPitches       = p.manualPitches;
      if (p.microtonalIntervals) state.microtonalIntervals = p.microtonalIntervals;
      if (p.gestureSensitivity)  Object.assign(state.gestureSensitivity, p.gestureSensitivity);
      if (p.fmParams)            Object.assign(state.fmParams, p.fmParams);
      if (p.keyMap)              state.keyMap = p.keyMap;

      rebuildCodeIndex();

      // Rebuild synth with loaded instrument
      engine.switchInstrument(state.instrument);

      // Sync all range/select inputs to loaded state
      document.getElementById('keyCount').value    = state.buttonCount;
      document.getElementById('keyCountVal').textContent = state.buttonCount;
      document.getElementById('rootNote').value    = state.scale.root;
      document.getElementById('rootOctave').value  = state.scale.octave;

      // Re-activate the correct seg-btn for instrument, pitchMode, scale
      const activateSeg = (containerId, value) => {
        document.querySelectorAll(`#${containerId} .seg-btn`).forEach((b) => {
          b.classList.toggle('active', b.dataset.value === value);
        });
      };
      activateSeg('instrumentPicker', state.instrument);
      activateSeg('pitchModePicker', state.pitchMode);
      activateSeg('scalePicker', state.scale.type);

      document.getElementById('ySens').value      = state.gestureSensitivity.y;
      document.getElementById('xSens').value      = state.gestureSensitivity.x;
      document.getElementById('ySensVal').textContent = state.gestureSensitivity.y.toFixed(1);
      document.getElementById('xSensVal').textContent = state.gestureSensitivity.x.toFixed(1);

      document.getElementById('modIndex').value       = state.fmParams.modulationIndex;
      document.getElementById('modIndexVal').textContent = state.fmParams.modulationIndex;
      document.getElementById('harmonicity').value    = state.fmParams.harmonicity;
      document.getElementById('harmonicityVal').textContent = state.fmParams.harmonicity;
      document.getElementById('fmAttack').value       = state.fmParams.attack;
      document.getElementById('attackVal').textContent = state.fmParams.attack.toFixed(3);
      document.getElementById('fmDecay').value        = state.fmParams.decay;
      document.getElementById('decayVal').textContent = state.fmParams.decay.toFixed(2);
      document.getElementById('fmSustain').value      = state.fmParams.sustain;
      document.getElementById('sustainVal').textContent = state.fmParams.sustain.toFixed(2);
      document.getElementById('fmRelease').value      = state.fmParams.release;
      document.getElementById('releaseVal').textContent = state.fmParams.release.toFixed(2);

      document.getElementById('microtonalIntervals').value = state.microtonalIntervals.join(', ');

      recomputePitches();
      renderKeyGrid();
      syncSettingsUI();

      const btn = document.getElementById('btnLoad');
      const prev = btn.textContent;
      btn.textContent = 'LOADED ✓';
      setTimeout(() => { btn.textContent = prev; }, 1600);
    } catch (err) {
      console.error('Preset load error:', err);
    }
  });

  // ── Orientation change: re-render grid ──
  window.addEventListener('resize', () => {
    renderKeyGrid();
  });
}


// ─── URL State Encoding / Sharing ───────────────────────────────

const PRESET_KEYS = [
  'instrument', 'buttonCount', 'pitchMode', 'scale',
  'manualPitches', 'microtonalIntervals', 'gestureSensitivity',
  'fmParams', 'keyMap',
];

function encodeState() {
  const snapshot = {};
  PRESET_KEYS.forEach((k) => { snapshot[k] = state[k]; });
  const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(snapshot));
  return '#s=' + compressed;
}

/**
 * Merge URL-encoded state into `state` before the app starts.
 * Returns true if a valid state was found and loaded.
 */
function loadStateFromURL() {
  const hash = location.hash;
  if (!hash.startsWith('#s=')) return false;
  try {
    const json = LZString.decompressFromEncodedURIComponent(hash.slice(3));
    if (!json) return false;
    const p = JSON.parse(json);
    if (p.instrument)          state.instrument          = p.instrument;
    if (p.buttonCount)         state.buttonCount         = p.buttonCount;
    if (p.pitchMode)           state.pitchMode           = p.pitchMode;
    if (p.scale)               Object.assign(state.scale, p.scale);
    if (p.manualPitches)       state.manualPitches       = p.manualPitches;
    if (p.microtonalIntervals) state.microtonalIntervals = p.microtonalIntervals;
    if (p.gestureSensitivity)  Object.assign(state.gestureSensitivity, p.gestureSensitivity);
    if (p.fmParams)            Object.assign(state.fmParams, p.fmParams);
    if (p.keyMap)              state.keyMap              = p.keyMap;
    return true;
  } catch (err) {
    console.warn('URL state decode error:', err);
    return false;
  }
}

function showShareModal() {
  // Build the shareable URL — works for both file:// (local) and https:// (deployed)
  const base = location.href.replace(/#.*$/, '');
  const url = base + encodeState();

  document.getElementById('shareUrl').value = url;

  // Show the modal immediately — QR generation happens after
  document.getElementById('shareModal').classList.remove('hidden');

  // Clear any previous QR, then attempt generation
  const container = document.getElementById('qrContainer');
  container.innerHTML = '';
  try {
    new QRCode(container, {
      text: url,
      width: 200,
      height: 200,
      colorDark: '#d4ff00',
      colorLight: '#000000',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (err) {
    console.error('QR generation failed:', err);
    container.innerHTML = '<p style="font-size:0.65rem;color:#484848;text-align:center;padding:16px 0">QR unavailable — use the link above</p>';
  }
}

function hideShareModal() {
  document.getElementById('shareModal').classList.add('hidden');
}

function initShareControls() {
  document.getElementById('btnShare').addEventListener('click', () => {
    closeSettings();
    showShareModal();
  });

  document.getElementById('btnCloseShare').addEventListener('click', hideShareModal);

  // Close on backdrop click (outside the box)
  document.getElementById('shareModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('shareModal')) hideShareModal();
  });

  document.getElementById('btnCopyLink').addEventListener('click', () => {
    const url = document.getElementById('shareUrl').value;
    const btn = document.getElementById('btnCopyLink');
    const prev = btn.textContent;

    const flash = () => {
      btn.textContent = 'COPIED ✓';
      setTimeout(() => { btn.textContent = prev; }, 1800);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(flash).catch(() => fallbackCopy(url, flash));
    } else {
      fallbackCopy(url, flash);
    }
  });
}

function fallbackCopy(text, done) {
  const ta = document.getElementById('shareUrl');
  ta.select();
  ta.setSelectionRange(0, 99999);
  try { document.execCommand('copy'); } catch (_) {}
  done();
}


// ─── Bootstrap ───────────────────────────────────────────────────

// Pre-populate state from URL hash before anything renders
loadStateFromURL();

document.getElementById('startBtn').addEventListener('click', async () => {
  // Resume AudioContext (required by browser autoplay policy)
  await Tone.start();

  // Build audio engine (switches instrument if URL-loaded state differs from default)
  engine = new AudioEngine();
  if (state.instrument !== 'piano') engine.switchInstrument(state.instrument);

  // Compute initial pitches and render
  recomputePitches();
  renderKeyGrid();

  // Wire all controls
  initControls();
  initKeyboardLayer();
  initShareControls();
  syncSettingsUI();

  // Show app, hide gate
  document.getElementById('audioGate').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
});
