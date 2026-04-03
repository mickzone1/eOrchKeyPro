'use strict';

const APP_VERSION = '202604022351';

// Restore saved accent colour immediately (before first paint)
(function () {
  const saved = localStorage.getItem('eOrchKey_accent');
  if (saved) document.documentElement.style.setProperty('--c-accent', saved);
}());

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

const SOLFEGE = {
  'C':'Do','C#':'Di','D':'Re','D#':'Ri','E':'Mi',
  'F':'Fa','F#':'Fi','G':'Sol','G#':'Si','A':'La','A#':'Li','B':'Ti',
};
function getSolfege(noteStr) {
  return SOLFEGE[noteStr.replace(/\d+$/, '')] ?? '';
}

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
  'Space', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG',
  'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote',
];

/** Human-readable short labels for display on buttons and in the editor. */
const KEY_DISPLAY = {
  ArrowLeft: '←', ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓',
  Space: 'SPC',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Semicolon: ';', Quote: "'",
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

/** True when the app was loaded from a locked share URL — settings are inaccessible. */
let settingsLocked = false;


// ─── Application State ───────────────────────────────────────────

const state = {
  instrument: 'piano',
  buttonCount: 6,
  pitchMode: 'scale',
  scale: { root: 'C', octave: 4, type: 'pentatonic' },
  manualPitches: ['C3','D3','E3','F3','G3','A3','B3','C4','D4','E4','F4','G4','A4','B4','C5','D5'],
  microtonalIntervals: [0, 75, 150, 225, 300, 375, 450, 525, 600, 675, 750, 825, 900, 975, 1050, 1125],
  gestureSensitivity: { y: 1.0, x: 1.0, filterOn: false, pitchBendOn: false },
  fmParams: {
    attack: 0.01,
    decay: 0.3,
    sustain: 0.5,
    release: 0.8,
    modulationIndex: 3,
    harmonicity: 1.5,
  },
  dynamics: 0,                   // master volume offset in dB (−30 to 0)
  noteDisplay: 'both',           // 'note' | 'both' | 'solfege'
  accentColour: localStorage.getItem('eOrchKey_accent') ?? '#d4ff00',
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
 * Velocity from vertical tap position within a key element.
 * Top of key = loud (1.0), bottom = soft (0.25).
 */
function tapVelocity(e, btnEl) {
  const rect = btnEl.getBoundingClientRect();
  const relY = Math.max(0, Math.min((e.clientY - rect.top) / rect.height, 1));
  return mapRange(relY, 0, 1, 1.0, 0.25);
}


// ─── Key Grid Rendering ──────────────────────────────────────────

function renderKeyGrid() {
  const grid = document.getElementById('keyGrid');
  grid.innerHTML = '';

  const isPortrait = window.innerHeight > window.innerWidth;
  const count = state.buttonCount;

  if (count <= 4) {
    grid.style.gridTemplateColumns = `repeat(${count}, 1fr)`;
    grid.style.gridTemplateRows = '1fr';
  } else if (count <= 8) {
    if (isPortrait) {
      grid.style.gridTemplateColumns = `repeat(${Math.ceil(count / 2)}, 1fr)`;
      grid.style.gridTemplateRows = '1fr 1fr';
    } else {
      grid.style.gridTemplateColumns = `repeat(${count}, 1fr)`;
      grid.style.gridTemplateRows = '1fr';
    }
  } else {
    // 9–16 buttons: 2 rows landscape, 4 rows portrait
    const rows = isPortrait ? 4 : 2;
    const cols = Math.ceil(count / rows);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
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
      ${state.noteDisplay !== 'solfege' ? `<div class="key-note">${pitch.label}</div>` : ''}
      ${state.noteDisplay !== 'note'    ? `<div class="key-solfege">${getSolfege(pitch.note)}</div>` : ''}
      <div class="key-freq">${Math.round(pitch.freq)} Hz</div>
    `;

    // ── Pointer Down ──
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);

      engine.triggerAttack(pitch, tapVelocity(e, btn));
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

      // Expression only when 2+ fingers are on screen
      if (activePointers.size >= 2) {
        if (state.gestureSensitivity.filterOn) {
          const dy = (ptr.originY - e.clientY) * state.gestureSensitivity.y;
          engine.setFilterCutoff(mapRange(dy, -220, 220, 180, 14000));
        }
        if (state.gestureSensitivity.pitchBendOn) {
          const dx = (e.clientX - ptr.originX) * state.gestureSensitivity.x;
          engine.setPitchBend(mapRange(dx, -220, 220, -3, 3));
        }
      }

      // ── Key transition detection ──
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const newBtn = el?.closest('.key[data-index]');
      const newIdx = newBtn ? Number(newBtn.dataset.index) : -1;
      if (newIdx !== -1 && newIdx !== ptr.keyIndex) {
        engine.triggerRelease(ptr.pitch);
        keyButtonEl(ptr.keyIndex)?.classList.remove('active');
        const newPitch = state.computedPitches[newIdx];
        engine.triggerAttack(newPitch, tapVelocity(e, newBtn));
        keyButtonEl(newIdx)?.classList.add('active');
        ptr.keyIndex = newIdx;
        ptr.pitch = newPitch;
        ptr.originX = e.clientX;
        ptr.originY = e.clientY;
      }
    });

    // ── Pointer Up / Cancel ──
    const onRelease = (e) => {
      const ptr = activePointers.get(e.pointerId);
      if (!ptr) return;

      engine.triggerRelease(ptr.pitch);
      activePointers.delete(e.pointerId);
      keyButtonEl(ptr.keyIndex)?.classList.remove('active');

      // Reset expression when dropping to 1 finger or fewer
      if (activePointers.size <= 1) {
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


// ─── Accent Colour ───────────────────────────────────────────────

const THEME_COLOURS = [
  { name: 'Red',         value: '#ff4d4d' },
  { name: 'Yellow',      value: '#d4ff00' },
  { name: 'Orange',      value: '#ff8c00' },
  { name: 'Green',       value: '#00ff88' },
  { name: 'Light Green', value: '#90ff90' },
  { name: 'Blue',        value: '#4d9fff' },
  { name: 'Purple',      value: '#cc66ff' },
  { name: 'White',       value: '#ffffff' },
];

function applyAccentColour(hex) {
  state.accentColour = hex;
  document.documentElement.style.setProperty('--c-accent', hex);
  localStorage.setItem('eOrchKey_accent', hex);
  document.querySelectorAll('.colour-swatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.colour === hex);
  });
}

function initColourPicker() {
  const container = document.getElementById('colourPicker');
  const current = state.accentColour;
  THEME_COLOURS.forEach(({ name, value }) => {
    const btn = document.createElement('button');
    btn.className = 'colour-swatch' + (value === current ? ' active' : '');
    btn.style.background = value;
    btn.dataset.colour = value;
    btn.title = name;
    btn.setAttribute('aria-label', name);
    btn.addEventListener('click', () => applyAccentColour(value));
    container.appendChild(btn);
  });
}


// ─── Settings UI Sync ────────────────────────────────────────────

function updateDynamicsIndicator() {
  const bars = document.querySelectorAll('.dyn-bar');
  const activeBars = Math.round((state.dynamics + 30) / 30 * 5);
  bars.forEach((bar, i) => bar.classList.toggle('active', i < activeBars));
}

function syncRootDisplay() {
  const el = document.getElementById('rootNoteDisplay');
  if (el) el.textContent = state.scale.root + state.scale.octave;
}

function syncSettingsUI() {
  const BADGE = { piano: 'PIANO', flute: 'FLUTE', vibraphone: 'VIBES', fmSynth: 'FM SYNTH' };
  document.getElementById('instrumentBadge').textContent = (BADGE[state.instrument] ?? 'SYNTH') + ' ▾';
  document.querySelectorAll('#instrumentDropdown .instr-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === state.instrument);
  });

  // Sync select inputs to state (important after URL-load or preset-load)
  document.getElementById('keyCount').value  = state.buttonCount;
  document.getElementById('keyCountVal').textContent = state.buttonCount;
  updateDynamicsIndicator();
  syncRootDisplay();
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
  activateSeg('solfegePicker', state.noteDisplay);
  activateSeg('filterToggle', state.gestureSensitivity.filterOn ? 'on' : 'off');
  activateSeg('pitchBendToggle', state.gestureSensitivity.pitchBendOn ? 'on' : 'off');

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
      <span class="manual-note-display">${val}</span>
      <button class="manual-pick-btn" data-idx="${i}">CHANGE</button>
    `;
    row.querySelector('.manual-pick-btn').addEventListener('click', (e) => {
      openNotePicker(Number(e.currentTarget.dataset.idx));
    });
    container.appendChild(row);
  }
}


// ─── Drawer ──────────────────────────────────────────────────────

function openSettings() {
  if (settingsLocked) return;
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

  // ── Instrument badge dropdown ──
  const instrBadge = document.getElementById('instrumentBadge');
  const instrDropdown = document.getElementById('instrumentDropdown');
  instrBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !instrDropdown.classList.contains('hidden');
    instrDropdown.classList.toggle('hidden', open);
    instrBadge.setAttribute('aria-expanded', String(!open));
  });
  instrDropdown.querySelectorAll('.instr-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.instrument = btn.dataset.value;
      engine.switchInstrument(btn.dataset.value);
      instrDropdown.classList.add('hidden');
      instrBadge.setAttribute('aria-expanded', 'false');
      syncSettingsUI();
    });
  });
  document.addEventListener('click', () => {
    instrDropdown.classList.add('hidden');
    instrBadge.setAttribute('aria-expanded', 'false');
  });

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

  // ── Solfège / note display mode ──
  bindSegmented('solfegePicker', (value) => {
    state.noteDisplay = value;
    renderKeyGrid();
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

  bindSegmented('filterToggle', (v) => {
    state.gestureSensitivity.filterOn = (v === 'on');
    if (!state.gestureSensitivity.filterOn) engine.resetFilter();
  });
  bindSegmented('pitchBendToggle', (v) => {
    state.gestureSensitivity.pitchBendOn = (v === 'on');
    if (!state.gestureSensitivity.pitchBendOn) engine.resetPitchBend();
  });

  // ── FM synth params ──
  bindRange('modIndex',   'modIndexVal',   (v) => { state.fmParams.modulationIndex = v; engine.updateFMParams(); }, 1);
  bindRange('harmonicity','harmonicityVal',(v) => { state.fmParams.harmonicity = v;     engine.updateFMParams(); }, 1);
  bindRange('fmAttack',   'attackVal',     (v) => { state.fmParams.attack = v;          engine.updateFMParams(); }, 3);
  bindRange('fmDecay',    'decayVal',      (v) => { state.fmParams.decay = v;           engine.updateFMParams(); }, 2);
  bindRange('fmSustain',  'sustainVal',    (v) => { state.fmParams.sustain = v;         engine.updateFMParams(); }, 2);
  bindRange('fmRelease',  'releaseVal',    (v) => { state.fmParams.release = v;         engine.updateFMParams(); }, 2);

  // ── Orientation change: re-render grid ──
  window.addEventListener('resize', () => {
    renderKeyGrid();
  });
}


// ─── Note Picker ─────────────────────────────────────────────────

let notePickerTarget = -1;      // ≥0: per-button mode; -2: root picker mode
let notePickerStartOctave = 3;
let notePickerPreview = null;   // note string currently highlighted
let notePickerPlaying = null;   // note string currently sounding (for release)

const BLACK_KEY_NAMES = new Set(['C#', 'D#', 'F#', 'G#', 'A#']);
const WHITE_KEY_W = 36;
const BLACK_KEY_W = 22;

function openNotePicker(btnIdx) {
  notePickerTarget = btnIdx;
  notePickerPreview = state.manualPitches[btnIdx] ?? 'C4';
  const match = notePickerPreview.match(/(\d+)$/);
  notePickerStartOctave = match ? Math.max(1, Math.min(6, Number(match[1]) - 1)) : 3;
  document.getElementById('notePickerTitle').textContent = `SELECT NOTE — BUTTON ${btnIdx + 1}`;
  renderPianoKeys();
  document.getElementById('notePickerModal').classList.remove('hidden');
}

function openRootPicker() {
  notePickerTarget = -2;
  notePickerPreview = state.scale.root + state.scale.octave;
  notePickerStartOctave = Math.max(1, Math.min(6, state.scale.octave - 1));
  document.getElementById('notePickerTitle').textContent = 'SELECT ROOT NOTE';
  renderPianoKeys();
  document.getElementById('notePickerModal').classList.remove('hidden');
}

function closeNotePicker() {
  if (notePickerPlaying) {
    try { engine.triggerRelease({ note: notePickerPlaying }); } catch (_) {}
    notePickerPlaying = null;
  }
  notePickerTarget = -1;
  notePickerPreview = null;
  document.getElementById('notePickerModal').classList.add('hidden');
}

function commitNotePicker() {
  if (notePickerPreview === null) { closeNotePicker(); return; }
  if (notePickerTarget >= 0) {
    state.manualPitches[notePickerTarget] = notePickerPreview;
    recomputePitches();
    renderKeyGrid();
    renderManualPitchInputs();
  } else if (notePickerTarget === -2) {
    const match = notePickerPreview.match(/^([A-G]#?)(\d+)$/);
    if (match) {
      state.scale.root = match[1];
      state.scale.octave = Number(match[2]);
      syncRootDisplay();
      recomputePitches();
      renderKeyGrid();
    }
  }
  closeNotePicker();
}

function renderPianoKeys() {
  const container = document.getElementById('pianoKeys');
  container.innerHTML = '';

  const currentNote = notePickerPreview ?? 'C4';
  let whiteCount = 0;

  for (let oct = notePickerStartOctave; oct < notePickerStartOctave + 3; oct++) {
    for (const name of NOTE_NAMES) {
      const noteStr = name + oct;
      const isBlack = BLACK_KEY_NAMES.has(name);
      const isSelected = noteStr === currentNote;

      const el = document.createElement('div');

      if (isBlack) {
        el.className = 'pk-black' + (isSelected ? ' selected' : '');
        el.style.left = (whiteCount * WHITE_KEY_W - BLACK_KEY_W / 2) + 'px';
        el.style.width = BLACK_KEY_W + 'px';
      } else {
        el.className = 'pk-white' + (isSelected ? ' selected' : '');
        el.style.width = WHITE_KEY_W + 'px';
        const label = name === 'C' ? name + oct : name;
        el.innerHTML = `<span class="pk-label">${label}</span>`;
        whiteCount++;
      }

      el.addEventListener('click', () => {
        // Release previously previewed note
        if (notePickerPlaying) {
          try { engine.triggerRelease({ note: notePickerPlaying }); } catch (_) {}
        }
        // Play and preview the tapped note
        engine.triggerAttack({ note: noteStr, detuneOffset: 0 }, 0.7);
        notePickerPlaying = noteStr;
        notePickerPreview = noteStr;
        renderPianoKeys(); // re-highlight without closing
      });

      container.appendChild(el);
    }
  }

  document.getElementById('notePickerOctLabel').textContent =
    `C${notePickerStartOctave} – B${notePickerStartOctave + 2}`;

  // Scroll selected key into view
  const wrap = document.querySelector('.piano-scroll-wrap');
  const selectedEl = container.querySelector('.selected');
  if (selectedEl && wrap) {
    const elLeft = selectedEl.offsetLeft;
    const wrapWidth = wrap.offsetWidth;
    wrap.scrollLeft = Math.max(0, elLeft - wrapWidth / 2 + WHITE_KEY_W / 2);
  }
}

function initNotePickerControls() {
  document.getElementById('notePickerOK').addEventListener('click', commitNotePicker);
  document.getElementById('notePickerCancel').addEventListener('click', closeNotePicker);
  document.getElementById('notePickerModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('notePickerModal')) closeNotePicker();
  });
  document.getElementById('notePickerOctDown').addEventListener('click', () => {
    notePickerStartOctave = Math.max(0, notePickerStartOctave - 1);
    renderPianoKeys();
  });
  document.getElementById('notePickerOctUp').addEventListener('click', () => {
    notePickerStartOctave = Math.min(6, notePickerStartOctave + 1);
    renderPianoKeys();
  });
  document.getElementById('rootNoteDisplay').addEventListener('click', openRootPicker);
}


// ─── URL State Encoding / Sharing ───────────────────────────────

const PRESET_KEYS = [
  'instrument', 'buttonCount', 'pitchMode', 'scale',
  'manualPitches', 'microtonalIntervals', 'gestureSensitivity',
  'fmParams', 'keyMap', 'dynamics', 'noteDisplay', 'accentColour',
];

function encodeState(locked = false) {
  const snapshot = {};
  PRESET_KEYS.forEach((k) => { snapshot[k] = state[k]; });
  if (locked) snapshot.locked = true;
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
    if (typeof p.dynamics === 'number')  state.dynamics   = p.dynamics;
    if (p.noteDisplay)                       state.noteDisplay  = p.noteDisplay;
    else if (p.showSolfege === true)          state.noteDisplay  = 'both'; // back-compat
    if (p.accentColour)        applyAccentColour(p.accentColour);
    if (p.locked === true)     settingsLocked            = true;
    return true;
  } catch (err) {
    console.warn('URL state decode error:', err);
    return false;
  }
}

function showShareModal(locked = false) {
  // Build the shareable URL — works for both file:// (local) and https:// (deployed)
  const base = location.href.replace(/#.*$/, '');
  const url = base + encodeState(locked);

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
      colorDark: '#000000',
      colorLight: '#ffffff',
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
    // Reset lock toggle to OFF each time the modal opens
    const toggle = document.getElementById('btnLockToggle');
    toggle.dataset.locked = 'false';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.textContent = 'OFF';
    showShareModal(false);
  });

  document.getElementById('btnLockToggle').addEventListener('click', () => {
    const toggle = document.getElementById('btnLockToggle');
    const newState = toggle.dataset.locked !== 'true';
    toggle.dataset.locked = String(newState);
    toggle.setAttribute('aria-pressed', String(newState));
    toggle.textContent = newState ? 'ON' : 'OFF';
    showShareModal(newState);
  });

  document.getElementById('btnDownloadQR').addEventListener('click', () => {
    const canvas = document.querySelector('#qrContainer canvas');
    const img    = document.querySelector('#qrContainer img');
    const src    = canvas ? canvas.toDataURL('image/png') : img?.src;
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = 'eorchkey-qr.png';
    a.click();
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
  Tone.getDestination().volume.value = state.dynamics;
  // Override iOS silent-mode mute — treat app as a media playback app (iOS 16.4+)
  if (navigator.audioSession) navigator.audioSession.type = 'playback';

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
  initNotePickerControls();
  initColourPicker();
  syncSettingsUI();

  // Show app, hide gate
  document.getElementById('audioGate').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('appVersion').textContent = 'v' + APP_VERSION;
  updateDynamicsIndicator();

  // Make topbar dynamics bars tappable — bar i sets volume to -24+(i*6) dB
  document.querySelectorAll('#dynamicsIndicator .dyn-bar').forEach((bar, i) => {
    bar.addEventListener('click', () => {
      const v = -24 + i * 6;   // bar 0=−24, 1=−18, 2=−12, 3=−6, 4=0
      state.dynamics = v;
      Tone.getDestination().volume.rampTo(v, 0.1);
      updateDynamicsIndicator();
    });
  });
  if (settingsLocked) {
    document.getElementById('settingsBtn').style.display = 'none';
  }
});
