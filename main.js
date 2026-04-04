'use strict';

const APP_VERSION = '202604042226';

// ─── Supabase Configuration ───────────────────────────────────────
// Replace these placeholders after creating your Supabase project.
// The anon key is intentionally public — RLS is the security boundary.
const SUPABASE_URL  = 'https://tshjhesxozwdpoxnqdrj.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzaGpoZXN4b3p3ZHBveG5xZHJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMTI4MDgsImV4cCI6MjA5MDc4ODgwOH0.k2VxoXWxPOT4AX77w7BFrWMj90accvbKVG3_gS5sJCc';
const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON) ?? null;

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

/** True after the app shell has been initialised (prevents double-wiring of controls). */
let appStarted = false;

/** True after Tone.start() has successfully resumed the AudioContext. */
let audioReady = false;


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
  keyLabels: { note: true, solfege: true, freq: true }, // independent toggles
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
    this._baseVolume = this.synth.volume.value;
    this.synth.maxPolyphony = 16;
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
    if (pitch.detuneOffset !== 0) {
      this.synth.set({ detune: Math.round(pitch.detuneOffset) });
    }
    const v = Math.max(0.05, Math.min(velocity, 1));
    // Explicitly apply velocity for all instruments regardless of Tone.js internals
    this.synth.volume.value = this._baseVolume + 20 * Math.log10(v);
    try {
      this.synth.triggerAttack(pitch.note, Tone.now(), v);
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
 * Top 15% and bottom 15% are dead zones (clamped to max/min).
 * Active zone (middle 70%): loud (1.0) at top → soft (0.12) at bottom.
 */
function tapVelocity(e, btnEl) {
  const rect = btnEl.getBoundingClientRect();
  const relY = Math.max(0, Math.min((e.clientY - rect.top) / rect.height, 1));
  const zoneY = Math.max(0, Math.min((relY - 0.15) / 0.70, 1));
  return mapRange(zoneY, 0, 1, 1.0, 0.12);
}

/** Move the key-dot to the finger's position within a key button.
 *  Constrains motion to a single axis (horizontal OR vertical) — whichever
 *  displacement from the button centre is larger. */
function moveDotTo(btnEl, e) {
  const dot = btnEl?.querySelector('.key-dot');
  if (!dot) return;
  const rect = btnEl.getBoundingClientRect();
  const x = Math.max(10, Math.min(90, ((e.clientX - rect.left) / rect.width)  * 100));
  const y = Math.max(10, Math.min(90, ((e.clientY - rect.top)  / rect.height) * 100));
  // Lock to dominant axis relative to centre
  if (Math.abs(x - 50) >= Math.abs(y - 50)) {
    dot.style.left = x + '%';
    dot.style.top  = '50%';
  } else {
    dot.style.left = '50%';
    dot.style.top  = y + '%';
  }
}

/** Reset the key-dot back to the CSS-defined centre position. */
function resetDot(btnEl) {
  const dot = btnEl?.querySelector('.key-dot');
  if (!dot) return;
  dot.style.left = '';
  dot.style.top  = '';
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
      ${state.keyLabels.note    ? `<div class="key-note">${pitch.label}</div>` : ''}
      ${state.keyLabels.solfege ? `<div class="key-solfege">${getSolfege(pitch.note)}</div>` : ''}
      ${state.keyLabels.freq    ? `<div class="key-freq">${Math.round(pitch.freq)} Hz</div>` : ''}
    `;

    // ── Pointer Down ──
    btn.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);

      if (!engine) {
        // Audio deferred (teacher auto-start flow) — wait briefly for resumeAudio handler
        await new Promise((r) => setTimeout(r, 100));
        if (!engine) return;
      }
      const isExpression = activePointers.size >= 1;
      if (!isExpression) {
        engine.triggerAttack(pitch, tapVelocity(e, btn));
        btn.classList.add('active');
        moveDotTo(btn, e);
      }
      activePointers.set(e.pointerId, {
        keyIndex: idx,
        pitch,
        originX: e.clientX,
        originY: e.clientY,
        isExpression,
      });
    }, { passive: false });

    // ── Pointer Move (gesture expressions) ──
    btn.addEventListener('pointermove', (e) => {
      if (!engine) return;
      const ptr = activePointers.get(e.pointerId);
      if (!ptr) return;

      // Expression only when 2+ fingers are on screen
      if (activePointers.size >= 2) {
        if (state.gestureSensitivity.filterOn) {
          const dx = (e.clientX - ptr.originX) * state.gestureSensitivity.x;
          engine.setFilterCutoff(mapRange(dx, -220, 220, 180, 14000));
        }
        if (state.gestureSensitivity.pitchBendOn) {
          const dy = (ptr.originY - e.clientY) * state.gestureSensitivity.y;
          engine.setPitchBend(mapRange(dy, -220, 220, -3, 3));
        }
      }

      // ── Key transition + dot tracking (1st finger only) ──
      if (!ptr.isExpression) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const newBtn = el?.closest('.key[data-index]');
        const newIdx = newBtn ? Number(newBtn.dataset.index) : -1;
        if (newIdx !== -1 && newIdx !== ptr.keyIndex) {
          engine.triggerRelease(ptr.pitch);
          resetDot(keyButtonEl(ptr.keyIndex));
          keyButtonEl(ptr.keyIndex)?.classList.remove('active');
          const newPitch = state.computedPitches[newIdx];
          engine.triggerAttack(newPitch, tapVelocity(e, newBtn));
          keyButtonEl(newIdx)?.classList.add('active');
          moveDotTo(keyButtonEl(newIdx), e);
          ptr.keyIndex = newIdx;
          ptr.pitch = newPitch;
          ptr.originX = e.clientX;
          ptr.originY = e.clientY;
        } else {
          moveDotTo(keyButtonEl(ptr.keyIndex), e);
        }
      }
    });

    // ── Pointer Up / Cancel ──
    const onRelease = (e) => {
      if (!engine) return;
      const ptr = activePointers.get(e.pointerId);
      if (!ptr) return;

      if (!ptr.isExpression) {
        engine.triggerRelease(ptr.pitch);
        resetDot(keyButtonEl(ptr.keyIndex));
        keyButtonEl(ptr.keyIndex)?.classList.remove('active');
      }
      activePointers.delete(e.pointerId);

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
    if (!engine) return;

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
  activateSeg('filterToggle', state.gestureSensitivity.filterOn ? 'on' : 'off');
  activateSeg('pitchBendToggle', state.gestureSensitivity.pitchBendOn ? 'on' : 'off');
  document.querySelectorAll('#keyLabelsPicker .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', state.keyLabels[btn.dataset.key] ?? false);
  });

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
    if (settingsLocked) return;
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

  // ── Key labels (multi-select: Note / Solfège / Freq) ──
  document.querySelectorAll('#keyLabelsPicker .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      state.keyLabels[key] = !state.keyLabels[key];
      btn.classList.toggle('active', state.keyLabels[key]);
      recomputePitches();
      renderKeyGrid();
    });
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
  'fmParams', 'keyMap', 'dynamics', 'keyLabels', 'accentColour',
];

function encodeState(locked = false) {
  const snapshot = {};
  PRESET_KEYS.forEach((k) => { snapshot[k] = state[k]; });
  if (locked) snapshot.locked = true;
  const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(snapshot));
  return '#s=' + compressed;
}

/**
 * Shared merge logic — applies a plain state snapshot object onto `state`.
 * Used by both loadStateFromURL() and applyStateSnapshot().
 */
function mergeStateSnapshot(p) {
  if (p.instrument)                   state.instrument          = p.instrument;
  if (p.buttonCount)                  state.buttonCount         = p.buttonCount;
  if (p.pitchMode)                    state.pitchMode           = p.pitchMode;
  if (p.scale)                        Object.assign(state.scale, p.scale);
  if (p.manualPitches)                state.manualPitches       = p.manualPitches;
  if (p.microtonalIntervals)          state.microtonalIntervals = p.microtonalIntervals;
  if (p.gestureSensitivity)           Object.assign(state.gestureSensitivity, p.gestureSensitivity);
  if (p.fmParams)                     Object.assign(state.fmParams, p.fmParams);
  if (p.keyMap)                       state.keyMap              = p.keyMap;
  if (typeof p.dynamics === 'number') state.dynamics = p.dynamics;
  if (p.keyLabels)                    Object.assign(state.keyLabels, p.keyLabels);
  // back-compat: convert old noteDisplay / showFreq / showSolfege to keyLabels
  else if (p.noteDisplay) {
    state.keyLabels.note    = p.noteDisplay !== 'solfege';
    state.keyLabels.solfege = p.noteDisplay !== 'note';
    if (p.showFreq !== undefined) state.keyLabels.freq = p.showFreq;
  } else if (p.showSolfege === true) {
    state.keyLabels.note = true; state.keyLabels.solfege = true;
  }
  if (p.accentColour) applyAccentColour(p.accentColour);
}

/**
 * Apply a plain state snapshot after the app is already running
 * (e.g. loading a saved preset from Supabase).
 */
function applyStateSnapshot(snapshot, locked = false) {
  mergeStateSnapshot(snapshot);
  if (locked) settingsLocked = true;
  if (engine) {
    recomputePitches();
    renderKeyGrid();
    syncSettingsUI();
    if (settingsLocked) {
      document.getElementById('settingsBtn').style.display = 'none';
      document.getElementById('instrumentBadge').classList.add('topbar-instrument--locked');
    }
  }
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
    mergeStateSnapshot(p);
    if (p.locked === true) settingsLocked = true;
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


// ─── Supabase: Auth ──────────────────────────────────────────────

function initSupabase() {
  if (!sb) return;
  sb.auth.onAuthStateChange((_event, session) => onAuthChange(session));
  sb.auth.getSession().then(({ data: { session } }) => onAuthChange(session));
}

function onAuthChange(session) {
  const loggedIn = Boolean(session?.user);
  document.getElementById('teacherLoggedOut').classList.toggle('hidden', loggedIn);
  document.getElementById('teacherLoggedIn').classList.toggle('hidden', !loggedIn);

  const topbarEmail = document.getElementById('teacherTopbarEmail');
  if (loggedIn) {
    document.getElementById('teacherEmailDisplay').textContent = session.user.email;
    topbarEmail.textContent = session.user.email;
    topbarEmail.classList.remove('hidden');
    loadPresets().then(renderPresetList);
    loadClasses().then(renderClassList);
    if (!appStarted) autoStartForTeacher();
  } else {
    topbarEmail.textContent = '';
    topbarEmail.classList.add('hidden');
  }
}

function autoStartForTeacher() {
  // Show interface immediately — AudioContext deferred to first user touch
  appStarted = true;

  recomputePitches();
  renderKeyGrid();
  initControls();
  initKeyboardLayer();
  initShareControls();
  initNotePickerControls();
  initColourPicker();
  initAccountControls();
  syncSettingsUI();

  document.getElementById('audioGate').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('appVersion').textContent = 'v' + APP_VERSION;
  updateDynamicsIndicator();

  document.querySelectorAll('#dynamicsIndicator .dyn-bar').forEach((bar, i) => {
    bar.addEventListener('click', () => {
      const v = -24 + i * 6;
      state.dynamics = v;
      if (audioReady) Tone.getDestination().volume.rampTo(v, 0.1);
      updateDynamicsIndicator();
    });
  });

  if (settingsLocked) {
    document.getElementById('settingsBtn').style.display = 'none';
    document.getElementById('instrumentBadge').classList.add('topbar-instrument--locked');
  }

  // Resume AudioContext on first user touch (browser autoplay policy)
  const resumeAudio = async () => {
    if (audioReady) return;
    await Tone.start();
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    Tone.getDestination().volume.value = state.dynamics;
    engine = new AudioEngine();
    if (state.instrument !== 'piano') engine.switchInstrument(state.instrument);
    audioReady = true;
    document.removeEventListener('pointerdown', resumeAudio);
  };
  document.addEventListener('pointerdown', resumeAudio);
}

async function signIn(email) {
  if (!sb) throw new Error('Supabase not configured');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.href.replace(/[?#].*$/, '') },
  });
  if (error) throw error;
}

// ─── Supabase: Presets ────────────────────────────────────────────

async function savePreset(name) {
  const { data: { user } } = await sb.auth.getUser();
  const snap = {};
  PRESET_KEYS.forEach((k) => { snap[k] = state[k]; });
  const { error } = await sb.from('presets').insert({ owner_id: user.id, name, state_json: snap });
  if (error) throw error;
  renderPresetList(await loadPresets());
}

async function loadPresets() {
  const { data } = await sb.from('presets').select('id, name').order('created_at', { ascending: false });
  return data ?? [];
}

async function applyPresetById(id) {
  const { data } = await sb.from('presets').select('state_json').eq('id', id).single();
  if (data) applyStateSnapshot(data.state_json);
}

async function deletePreset(id) {
  await sb.from('presets').delete().eq('id', id);
  renderPresetList(await loadPresets());
}

// ─── Supabase: Classes ────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function createClass(name, presetId, locked) {
  const { data: { user } } = await sb.auth.getUser();
  const { data: preset } = await sb.from('presets').select('state_json').eq('id', presetId).single();
  let code, tries = 0;
  while (tries++ < 10) {
    code = generateCode();
    const { error } = await sb.from('classes').insert({
      owner_id: user.id, name, code,
      preset_id: presetId, state_snapshot: preset.state_json, locked,
    });
    if (!error) break;
    if (!error.message?.includes('unique')) throw error;
  }
  renderClassList(await loadClasses());
  return code;
}

async function loadClasses() {
  const { data } = await sb.from('classes')
    .select('id, name, code, locked, active, preset_id, presets(name)')
    .order('created_at', { ascending: false });
  return data ?? [];
}

// Anon-readable via RLS (active = true)
async function loadClass(code) {
  if (!sb) return null;
  const { data } = await sb.from('classes')
    .select('locked, state_snapshot')
    .eq('code', code.toUpperCase())
    .eq('active', true)
    .single();
  return data ?? null;
}

function showTopbarClassCode(code) {
  const el = document.getElementById('topbarClassCode');
  el.textContent = code;
  el.classList.remove('hidden');
}

async function applyClass(code) {
  const status = document.getElementById('joinClassStatus');
  status.textContent = 'Loading class…';
  const cls = await loadClass(code);
  if (!cls || !cls.state_snapshot) {
    status.textContent = 'Class not found.';
    return false;
  }
  applyStateSnapshot(cls.state_snapshot, cls.locked);
  showTopbarClassCode(code.toUpperCase());
  status.textContent = '';
  return true;
}

// Reads ?class= URL param on startup
async function checkClassParam() {
  const code = new URLSearchParams(location.search).get('class');
  if (!code) return;
  document.getElementById('classCodeInput').value = code.toUpperCase();
  await applyClass(code);
}

// ─── Supabase: UI Rendering ───────────────────────────────────────

function renderPresetList(presets) {
  const el = document.getElementById('presetList');
  el.innerHTML = presets.length
    ? presets.map((p) => `
        <div class="account-row">
          <span class="account-row-name">${p.name}</span>
          <button class="account-row-btn" data-action="load-preset" data-id="${p.id}">LOAD</button>
          <button class="account-row-btn account-row-btn--del" data-action="delete-preset" data-id="${p.id}">✕</button>
        </div>`).join('')
    : '<div class="account-empty">No presets saved yet</div>';
}

function renderClassList(classes) {
  const el = document.getElementById('classList');
  el.innerHTML = classes.length
    ? classes.map((c) => `
        <div class="account-row">
          <span class="account-row-code">${c.code}</span>
          <span class="account-row-name">${c.name}</span>
          <button class="account-row-btn" data-action="toggle-lock"
                  data-id="${c.id}" data-locked="${c.locked}">${c.locked ? 'UNLOCK' : 'LOCK'}</button>
          <button class="account-row-btn account-row-btn--del"
                  data-action="delete-class" data-id="${c.id}">✕</button>
        </div>`).join('')
    : '<div class="account-empty">No classes yet</div>';
}

function openCreateClassModal(name, presets) {
  // Remove any existing inline modal
  document.getElementById('createClassInline')?.remove();

  const wrap = document.createElement('div');
  wrap.id = 'createClassInline';
  wrap.className = 'create-class-inline';
  wrap.innerHTML = `
    <div class="setting-label">ASSIGN PRESET</div>
    <select id="ccPresetSelect">
      ${presets.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}
    </select>
    <div class="segmented" id="ccLockToggle">
      <button class="seg-btn active" data-value="true">LOCK SETTINGS</button>
      <button class="seg-btn" data-value="false">UNLOCKED</button>
    </div>
    <div class="preset-row mt8">
      <button id="ccConfirm" class="preset-btn preset-btn--share" style="flex:2">CREATE</button>
      <button id="ccCancel" class="preset-btn" style="flex:1">CANCEL</button>
    </div>
    <div id="ccStatus" class="auth-status"></div>
  `;
  document.getElementById('classList').after(wrap);

  // Wire lock toggle inside this modal
  wrap.querySelectorAll('#ccLockToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('#ccLockToggle .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('ccCancel').addEventListener('click', () => wrap.remove());

  document.getElementById('ccConfirm').addEventListener('click', async () => {
    const presetId = document.getElementById('ccPresetSelect').value;
    const locked   = wrap.querySelector('#ccLockToggle .seg-btn.active').dataset.value === 'true';
    const status   = document.getElementById('ccStatus');
    status.textContent = 'Creating…';
    try {
      const code = await createClass(name, presetId, locked);
      status.textContent = `Created! Code: ${code}`;
      document.getElementById('newClassName').value = '';
      setTimeout(() => wrap.remove(), 2500);
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  });
}

function initAccountControls() {
  if (!sb) return;

  document.getElementById('btnSendMagicLink').addEventListener('click', async () => {
    const email  = document.getElementById('teacherEmail').value.trim();
    const status = document.getElementById('authStatus');
    const btn    = document.getElementById('btnSendMagicLink');
    if (!email) { status.textContent = 'Please enter your email.'; return; }
    btn.disabled = true;
    btn.textContent = 'SENDING…';
    status.textContent = '';
    try {
      await signIn(email);
      status.textContent = 'Magic link sent — check your email!';
      btn.textContent = 'SENT ✓';
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
      btn.disabled = false;
      btn.textContent = 'SEND MAGIC LINK';
    }
  });

  document.getElementById('btnSavePreset').addEventListener('click', async () => {
    const name = document.getElementById('newPresetName').value.trim() || 'Untitled';
    await savePreset(name);
    document.getElementById('newPresetName').value = '';
  });

  document.getElementById('btnCreateClass').addEventListener('click', async () => {
    const name = document.getElementById('newClassName').value.trim();
    if (!name) return;
    openCreateClassModal(name, await loadPresets());
  });

  document.getElementById('btnSignOut').addEventListener('click', () => sb.auth.signOut());

  // Delegated clicks on preset / class rows
  document.getElementById('accountSection').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id, locked } = btn.dataset;
    if (action === 'load-preset')   await applyPresetById(id);
    if (action === 'delete-preset') await deletePreset(id);
    if (action === 'toggle-lock') {
      await sb.from('classes').update({ locked: locked !== 'true' }).eq('id', id);
      renderClassList(await loadClasses());
    }
    if (action === 'delete-class') {
      await sb.from('classes').delete().eq('id', id);
      renderClassList(await loadClasses());
    }
  });

}

// ─── Bootstrap ───────────────────────────────────────────────────

// Init Supabase auth listener and restore any existing session
initSupabase();

// Pre-populate state from URL hash before anything renders
loadStateFromURL();

// Pre-load class from ?class= URL param (async, completes before user taps BEGIN)
checkClassParam();

// Wire gate JOIN button immediately (works before TAP TO BEGIN)
if (sb) {
  document.getElementById('joinClassBtn').addEventListener('click', async () => {
    const code = document.getElementById('classCodeInput').value.trim();
    if (code.length !== 6) return;
    await Tone.start(); // call within gesture before any awaits (Safari requirement)
    const ok = await applyClass(code);
    if (ok) await startApp();
  });
  document.getElementById('classCodeInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const code = e.target.value.trim();
      if (code.length !== 6) return;
      await Tone.start();
      const ok = await applyClass(code);
      if (ok) await startApp();
    }
  });
}


async function startApp() {
  if (appStarted) return;
  appStarted = true;

  // Resume AudioContext (required by browser autoplay policy)
  await Tone.start();
  audioReady = true;
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
  initAccountControls();
  syncSettingsUI();

  // Show app, hide gate
  document.getElementById('audioGate').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('appVersion').textContent = 'v' + APP_VERSION;
  updateDynamicsIndicator();

  // Make topbar dynamics bars tappable — bar i sets volume to -24+(i*6) dB
  document.querySelectorAll('#dynamicsIndicator .dyn-bar').forEach((bar, i) => {
    bar.addEventListener('click', () => {
      const v = -24 + i * 6; // bar 0=−24, 1=−18, 2=−12, 3=−6, 4=0
      state.dynamics = v;
      Tone.getDestination().volume.rampTo(v, 0.1);
      updateDynamicsIndicator();
    });
  });

  if (settingsLocked) {
    document.getElementById('settingsBtn').style.display = 'none';
    document.getElementById('instrumentBadge').classList.add('topbar-instrument--locked');
  }
}

document.getElementById('startBtn').addEventListener('click', () => startApp());
