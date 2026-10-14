(function () {
  'use strict';

  let capturedH = null;
  let capturedS = null;
  let capturedB = null;
  let autoRunning = false;
  let stopFlag = false;
  let gameStartTime = 0;
  let desiredMode = 'easy';
  let playType = 'solo';

  const MODE_TIMINGS = {
    easy: { memorizeMs: 5000, inputTimerMs: null, minGameDurationMs: 15000, rounds: 5 },
    hard: { memorizeMs: 2000, inputTimerMs: null, minGameDurationMs: 15000, rounds: 5 },
    brutal: { memorizeMs: 2000, inputTimerMs: 3500, minGameDurationMs: 15000, rounds: 5 },
  };

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }

  function humanDelay(base, jitter) {
    return delay(base + rand(-jitter, jitter));
  }

  function waitFor(condFn, timeout = 10000, interval = 100) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (stopFlag) return reject(new Error('stopped'));
        const result = condFn();
        if (result) return resolve(result);
        if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
        setTimeout(check, interval);
      };
      check();
    });
  }

  function byClass(cls) {
    return document.querySelector('.' + cls);
  }

  function firstVisible(els) {
    for (const el of els) {
      if (
        el &&
        el.offsetParent !== null &&
        getComputedStyle(el).visibility !== 'hidden' &&
        getComputedStyle(el).display !== 'none'
      ) {
        return el;
      }
    }
    return null;
  }

  function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  function rgbToHsb(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;
    let h = 0;
    let s = 0;
    const bv = max;

    if (max !== 0) s = diff / max;
    if (diff !== 0) {
      if (max === r) h = ((g - b) / diff) % 6;
      else if (max === g) h = (b - r) / diff + 2;
      else h = (r - g) / diff + 4;
      h = h * 60;
      if (h < 0) h += 360;
    }

    // Keep the full HSB precision from the RGB target instead of rounding it away.
    return { h: h, s: s * 100, b: bv * 100 };
  }

  function hsbToRgb(h, s, b) {
    s /= 100;
    b /= 100;
    const k = n => (n + h / 60) % 6;
    const f = n => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
    return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), bl: Math.round(f(1) * 255) };
  }

  function extractHsbFromElement(el) {
    const bg = el.style.backgroundColor || getComputedStyle(el).backgroundColor;
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return null;
    return rgbToHsb(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]));
  }

  function getCountdownColor() {
    const el = byClass('CountdownScreen-module__W_NmWW__countdown');
    if (!el) return null;
    return extractHsbFromElement(el);
  }

  function getStripByLabel(label) {
    return document.querySelector(`[role="slider"][aria-label="${label}"]`);
  }

  function getStrips() {
    return {
      h: getStripByLabel('Hue'),
      s: getStripByLabel('Saturation'),
      b: getStripByLabel('Brightness'),
    };
  }

  function getStripValue(strip) {
    if (!strip) return null;
    const raw = strip.getAttribute('aria-valuenow');
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function getActiveScreen() {
    const screens = document.querySelectorAll('.screen');
    for (const screen of screens) {
      if (screen.classList.contains('active')) return screen;
    }
    return null;
  }

  function getCurrentMode() {
    const toggle = byClass('IntroScreen-module__Jq020W__modeToggle');
    if (toggle) return toggle.getAttribute('data-mode') || 'easy';
    return 'easy';
  }

  function ptrOpts(x, y, type) {
    return {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pageX: x,
      pageY: y,
      buttons: type === 'up' ? 0 : 1,
      button: 0,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
    };
  }

  function setSlider(stripEl, pct) {
    if (!stripEl) return;
    const rect = stripEl.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height * Math.max(0, Math.min(100, pct)) / 100;
    const origSetPointerCapture = stripEl.setPointerCapture;
    stripEl.setPointerCapture = function () {};

    try {
      stripEl.dispatchEvent(new PointerEvent('pointerdown', ptrOpts(x, y, 'down')));
      stripEl.dispatchEvent(new PointerEvent('pointermove', ptrOpts(x, y, 'move')));
      stripEl.dispatchEvent(new PointerEvent('pointerup', ptrOpts(x, y, 'up')));
      stripEl.dispatchEvent(new PointerEvent('pointercancel', ptrOpts(x, y, 'up')));
    } finally {
      stripEl.setPointerCapture = origSetPointerCapture;
    }
  }

  function easeOutQuad(t) {
    return 1 - (1 - t) * (1 - t);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function setSliderGradual(stripEl, targetPct, steps) {
    if (!stripEl) return;
    const currentPct = (() => {
      const val = parseInt(stripEl.getAttribute('aria-valuenow'));
      if (isNaN(val)) return targetPct;
      const range = stripEl.getAttribute('aria-label') === 'Hue' ? 360 : 100;
      return (val / range) * 100;
    })();

    const stepCount = steps || randInt(3, 6);
    for (let i = 1; i <= stepCount; i++) {
      const t = easeOutQuad(i / stepCount);
      const pct = currentPct + (targetPct - currentPct) * t;
      setSlider(stripEl, pct + rand(-0.3, 0.3));
      await delay(25);
    }
  }

  const MAX_TRIES = 120; // Up to about 2 seconds at 60 FPS.

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  function correctChannel(stripEl, targetVal, channelKey, attempt = 0, tolerance = 0) {
    return new Promise(resolve => {
      if (!stripEl || stopFlag) return resolve(false);

      const pct = channelKey === 'h' ? (targetVal / 360) * 100 : 100 - targetVal;

      async function attempt_() {
        for (let n = attempt; n < MAX_TRIES; n++) {
          if (stopFlag) return resolve(false);

          // Apply the target first, then verify on the next animation frame.
          setSlider(stripEl, pct);
          await nextFrame();

          const actual = getStripValue(stripEl);
          if (!Number.isFinite(actual)) return resolve(false);
          if (Math.abs(actual - targetVal) <= tolerance) return resolve(true);
        }
        resolve(false);
      }

      attempt_().catch(() => resolve(false));
    });
  }

  function perturbValue(val, maxDelta) {
    return Math.round(val + rand(-maxDelta, maxDelta));
  }

  function perturbTarget(h, s, b, isBrutal) {
    const deliberateMiss = isBrutal ? Math.random() < 0.30 : Math.random() < 0.15;
    const hDelta = isBrutal ? rand(1, 4) : deliberateMiss ? rand(10, 20) : rand(2, 8);
    const sDelta = isBrutal ? rand(1, 2) : deliberateMiss ? rand(5, 10) : rand(1, 4);
    const bDelta = isBrutal ? rand(1, 2) : deliberateMiss ? rand(5, 10) : rand(1, 4);
    return {
      h: ((perturbValue(h, hDelta) % 360) + 360) % 360,
      s: Math.max(0, Math.min(100, perturbValue(s, sDelta))),
      b: Math.max(0, Math.min(100, perturbValue(b, bDelta))),
    };
  }

  function emitJitter(stripEl) {
    if (!stripEl) return;
    const rect = stripEl.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height * rand(10, 90) / 100;
    stripEl.dispatchEvent(new PointerEvent('pointermove', ptrOpts(x, y, 'move')));
  }

  async function solveSliders(h, s, b, mode) {
    const strips = getStrips();
    const targets = {
      h: ((h % 360) + 360) % 360,
      s: Math.max(0, Math.min(100, s)),
      b: Math.max(0, Math.min(100, b)),
    };

    if (!strips.h || !strips.s || !strips.b) {
      throw new Error('Hue, saturation, or brightness slider is missing');
    }

    // Set the actual captured colour directly; do not deliberately perturb the target.
    const channels = [
      { key: 'h', target: targets.h, pct: (targets.h / 360) * 100 },
      { key: 's', target: targets.s, pct: 100 - targets.s },
      { key: 'b', target: targets.b, pct: 100 - targets.b },
    ];

    // Set all three sliders immediately, then check them together on the next frame.
    for (const channel of channels) {
      if (stopFlag) return;
      setSlider(strips[channel.key], channel.pct);
    }
    await nextFrame();

    // Sliders may quantize to whole numbers; accept the nearest representable value.
    // The initial set and verification happen in one animation-frame cycle.
    const corrections = [];
    for (const channel of channels) {
      const actual = getStripValue(strips[channel.key]);
      if (!Number.isFinite(actual) || Math.abs(actual - channel.target) > 0.5) {
        corrections.push(
          correctChannel(strips[channel.key], channel.target, channel.key, 0, 0.5)
        );
      }
    }

    const results = await Promise.all(corrections);
    if (!stopFlag && results.some(result => result === false)) {
      console.warn('[Solver] One or more sliders did not confirm the exact target value.');
    }
  }

  function findGoButton() {
    const btn = document.querySelector('button[aria-label="Submit"]');
    if (btn && btn.offsetParent !== null) return btn;
    return firstVisible([
      byClass('Input-module__pbIYDa__pickerGo'),
      byClass('Input-module__2knD8a__pickerGo'),
    ]);
  }

  function findNextButton() {
    const btn = document.querySelector('.RoundResult-module__HlUqJW__goBtn');
    if (btn && btn.offsetParent !== null) return btn;
    const btn2 = document.querySelector('.RoundResult-module__uGwT3G__goBtn');
    if (btn2 && btn2.offsetParent !== null) return btn2;
    return null;
  }

  async function setMode(targetMode) {
    const toggle = byClass('IntroScreen-module__Jq020W__modeToggle');
    if (!toggle) return;

    let currentMode = toggle.getAttribute('data-mode') || 'easy';
    if (currentMode === targetMode) return;
    const maxClicks = 4;
    for (let i = 0; i < maxClicks; i++) {
      click(toggle);
      await delay(200);
      currentMode = toggle.getAttribute('data-mode') || 'easy';
      if (currentMode === targetMode) return;
    }
  }

  async function runAutoLoop() {
    if (autoRunning) return;
    autoRunning = true;
    stopFlag = false;
    setStatus('Starting...');

    try {
      await humanDelay(1000, 300);

      if (playType === 'solo') {
        await setMode(desiredMode);
        await humanDelay(500, 200);
        setStatus(`Mode: ${desiredMode}`);
        const soloBtn = await waitFor(() => {
          const btn = document.querySelector('button[aria-label="Single player"]');
          if (btn && btn.offsetParent !== null) return btn;
          return null;
        }, 5000);
        click(soloBtn);
      } else {
        setStatus('Daily — entering initials...');
        const initialsInput = await waitFor(() => {
          const input = document.querySelector('input[aria-label="Enter initials"]');
          if (input && input.offsetParent !== null) return input;
          return null;
        }, 5000);

        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let initials = '';
        for (let i = 0; i < 3; i++) initials += chars[Math.floor(Math.random() * 26)];

        for (const ch of initials) {
          initialsInput.focus();
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
          ).set;
          nativeInputValueSetter.call(initialsInput, initialsInput.value + ch);
          initialsInput.dispatchEvent(new Event('input', { bubbles: true }));
          initialsInput.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(rand(80, 200));
        }

        await humanDelay(400, 150);
        const dailyBtn = await waitFor(() => {
          const btn = byClass('InitialsCtaRow-module__Bw_T5a__btnColorDaily');
          if (btn && btn.offsetParent !== null && !btn.disabled) return btn;
          const btns = document.querySelectorAll('.InitialsCtaRow-module__Bw_T5a__btn');
          for (const candidate of btns) {
            if (
              candidate.offsetParent !== null &&
              !candidate.disabled &&
              candidate.textContent.includes('daily')
            ) {
              return candidate;
            }
          }
          return null;
        }, 5000);
        click(dailyBtn);
      }

      gameStartTime = Date.now();
      const timings = MODE_TIMINGS[desiredMode] || MODE_TIMINGS.easy;
      const isBrutal = desiredMode === 'brutal';
      let round = 0;

      while (!stopFlag && round < (timings.rounds || 5)) {
        round++;
        setStatus(`Round ${round} — waiting...`);

        await waitFor(() => {
          const screen = getActiveScreen();
          if (!screen) return false;
          const countdown = screen.querySelector('.CountdownScreen-module__W_NmWW__countdown');
          if (!countdown) return false;
          const hsb = extractHsbFromElement(countdown);
          return hsb && !(hsb.h === 0 && hsb.s === 0 && hsb.b === 0);
        }, 15000);

        if (isBrutal) {
          await delay(100);
        } else {
          await humanDelay(600, 200);
        }
        if (stopFlag) break;

        const hsb = getCountdownColor();
        if (!hsb) throw new Error('Could not read countdown color');
        capturedH = hsb.h;
        capturedS = hsb.s;
        capturedB = hsb.b;
        updateSwatch(hsb.h, hsb.s, hsb.b);
        setStatus(`Round ${round} — solving...`);

        await waitFor(() => {
          const strips = getStrips();
          return strips.h && strips.s && strips.b;
        }, 8000);
        if (stopFlag) break;

        if (isBrutal) {
          await delay(50);
        } else {
          await humanDelay(400, 200);
        }

        await solveSliders(capturedH, capturedS, capturedB, desiredMode);
        if (stopFlag) break;

        if (isBrutal) {
          await delay(80);
        } else {
          await humanDelay(rand(1500, 3500), 400);
        }

        const goBtn = await waitFor(() => findGoButton(), 5000);
        click(goBtn);
        setStatus(`Round ${round} done`);

        const roundDelay = isBrutal ? rand(800, 1500) : rand(2500, 4000);
        await delay(roundDelay);
        if (stopFlag) break;

        const nextBtn = findNextButton();
        if (!nextBtn || nextBtn.offsetParent === null) {
          const elapsed = Date.now() - gameStartTime;
          const targetDuration = timings.minGameDurationMs + rand(1000, 9000);
          if (elapsed < targetDuration) {
            setStatus(`Waiting ${Math.ceil((targetDuration - elapsed) / 1000)}s...`);
            await delay(targetDuration - elapsed);
          }
          setStatus(`Done after ${round} rounds`);
          break;
        }

        await humanDelay(400, 150);
        click(nextBtn);
        await humanDelay(600, 250);
      }
    } catch (err) {
      if (err.message !== 'stopped') {
        console.error('[Solver] Error:', err);
        setStatus('Error');
      }
    } finally {
      autoRunning = false;
      if (stopFlag) setStatus('Off');
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #dg-panel {
      position: fixed;
      bottom: 22px;
      right: 22px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
      font-family: system-ui, sans-serif;
    }
    #dg-card {
      background: rgba(10, 12, 20, 0.88);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      min-width: 160px;
    }
    #dg-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.35);
    }
    #dg-mode-row, #dg-play-row { display: flex; gap: 4px; }
    #dg-mode-row button, #dg-play-row button {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: rgba(255,255,255,0.4);
      font-size: 10px;
      font-weight: 600;
      padding: 4px 10px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      transition: all 0.2s;
    }
    #dg-mode-row button:hover, #dg-play-row button:hover {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.6);
    }
    #dg-mode-row button.active, #dg-play-row button.active {
      background: rgba(100, 140, 255, 0.2);
      border-color: rgba(100, 140, 255, 0.4);
      color: rgba(100, 180, 255, 0.9);
    }
    #dg-swatch-row { display: flex; align-items: center; gap: 10px; }
    #dg-swatch {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.15);
      background: #333;
      flex-shrink: 0;
      display: none;
    }
    #dg-hsb { font-size: 11px; color: rgba(255,255,255,0.45); display: none; }
    #dg-status {
      font-size: 12px;
      font-weight: 500;
      color: rgba(255,255,255,0.7);
      text-align: center;
      min-height: 16px;
    }
    .dg-container {
      display: flex;
      align-items: center;
      justify-content: center;
      --hue: 220deg;
      --width: 7rem;
      --accent-hue: 215deg;
      --duration: 0.6s;
      --easing: cubic-bezier(1, 0, 1, 1);
    }
    .dg-togglesw { display: none; }
    .dg-switch {
      --shadow-offset: calc(var(--width) / 20);
      position: relative;
      cursor: pointer;
      display: flex;
      align-items: center;
      width: var(--width);
      height: calc(var(--width) / 2.5);
      border-radius: var(--width);
      box-shadow: inset 10px 10px 10px hsl(var(--hue) 20% 20%),
        inset -10px -10px 10px hsl(var(--hue) 20% 30%);
    }
    .dg-indicator {
      content: '';
      position: absolute;
      width: 40%;
      height: 60%;
      transition: all var(--duration) var(--easing);
      box-shadow: inset 0 0 2px hsl(var(--hue) 20% 15% / 60%),
        inset 0 0 3px 2px hsl(var(--hue) 20% 15% / 60%),
        inset 0 0 5px 2px hsl(var(--hue) 20% 45% / 60%);
    }
    .dg-indicator.left {
      --hue: var(--accent-hue);
      overflow: hidden;
      left: 10%;
      border-radius: 100px 0 0 100px;
      background: linear-gradient(180deg,
        hsl(210deg 100% 75%) 10%,
        hsl(215deg 100% 55%) 30%,
        hsl(220deg 90% 40%) 60%,
        hsl(220deg 90% 50%) 75%,
        hsl(220deg 90% 40%));
    }
    .dg-indicator.right {
      right: 10%;
      border-radius: 0 100px 100px 0;
      background-image: linear-gradient(180deg,
        hsl(var(--hue) 20% 35%),
        hsl(var(--hue) 20% 20%) 60%,
        hsl(var(--hue) 20% 25%) 70%,
        hsl(var(--hue) 20% 20%));
    }
    .dg-button {
      position: absolute;
      z-index: 1;
      width: 55%;
      height: 80%;
      left: 5%;
      border-radius: 100px;
      background-image: linear-gradient(160deg,
        hsl(var(--hue) 15% 75%) 40%, hsl(var(--hue) 15% 50%) 70%);
      transition: all var(--duration) var(--easing);
      box-shadow: 2px 2px 3px hsl(var(--hue) 18% 10% / 80%),
        2px 2px 6px hsl(var(--hue) 18% 10% / 40%),
        10px 20px 10px hsl(var(--hue) 18% 10% / 40%),
        20px 30px 30px hsl(var(--hue) 18% 10% / 60%);
    }
    .dg-button::before, .dg-button::after {
      content: '';
      position: absolute;
      top: 10%;
      width: 41%;
      height: 80%;
      border-radius: 100%;
    }
    .dg-button::before {
      left: 5%;
      box-shadow: inset 1px 1px 2px hsl(var(--hue) 15% 70%);
      background-image: linear-gradient(-50deg,
        hsl(var(--hue) 15% 80%) 20%, hsl(var(--hue) 15% 65%) 80%);
    }
    .dg-button::after {
      right: 5%;
      box-shadow: inset 1px 1px 3px hsl(var(--hue) 15% 50%);
      background-image: linear-gradient(-50deg,
        hsl(var(--hue) 15% 75%) 20%, hsl(var(--hue) 15% 55%) 80%);
    }
    .dg-togglesw:checked ~ .dg-button { left: 40%; }
    .dg-togglesw:not(:checked) ~ .dg-indicator.left,
    .dg-togglesw:checked ~ .dg-indicator.right {
      box-shadow: inset 0 0 5px hsl(var(--hue) 20% 5% / 100%),
        inset 20px 20px 10px hsl(var(--hue) 20% 5% / 100%),
        inset 20px 20px 15px hsl(var(--hue) 20% 20% / 100%);
    }
    #dg-toggle-label {
      font-size: 11px;
      font-weight: 600;
      color: rgba(255,255,255,0.4);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
  `;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'dg-panel';
  panel.innerHTML = `
    <div id="dg-card">
      <div id="dg-title">Dialed Solver</div>
      <div id="dg-mode-row">
        <button id="dg-mode-easy" class="active">Easy</button>
        <button id="dg-mode-hard">Hard</button>
        <button id="dg-mode-brutal">Brutal</button>
      </div>
      <div id="dg-play-row">
        <button id="dg-play-solo" class="active">Solo</button>
        <button id="dg-play-daily">Daily</button>
      </div>
      <div id="dg-swatch-row">
        <div id="dg-swatch"></div>
        <div id="dg-hsb"></div>
      </div>
      <div id="dg-status">Off</div>
      <div class="dg-container">
        <label class="dg-switch">
          <input class="dg-togglesw" type="checkbox" id="dg-toggle">
          <div class="dg-indicator left"></div>
          <div class="dg-indicator right"></div>
          <div class="dg-button"></div>
        </label>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  function updateModeButtons() {
    document.querySelectorAll('#dg-mode-row button').forEach(btn => {
      btn.classList.toggle('active', btn.id === `dg-mode-${desiredMode}`);
    });
  }

  function updatePlayButtons() {
    document.querySelectorAll('#dg-play-row button').forEach(btn => {
      btn.classList.toggle('active', btn.id === `dg-play-${playType}`);
    });
  }

  document.getElementById('dg-mode-easy').addEventListener('click', () => {
    desiredMode = 'easy';
    updateModeButtons();
  });
  document.getElementById('dg-mode-hard').addEventListener('click', () => {
    desiredMode = 'hard';
    updateModeButtons();
  });
  document.getElementById('dg-mode-brutal').addEventListener('click', () => {
    desiredMode = 'brutal';
    updateModeButtons();
  });

  document.getElementById('dg-play-solo').addEventListener('click', () => {
    playType = 'solo';
    updatePlayButtons();
  });
  document.getElementById('dg-play-daily').addEventListener('click', () => {
    playType = 'daily';
    updatePlayButtons();
  });

  const toggle = document.getElementById('dg-toggle');
  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      stopFlag = false;
      runAutoLoop();
    } else {
      stopFlag = true;
      if (!autoRunning) setStatus('Off');
    }
  });

  function setStatus(msg) {
    const el = document.getElementById('dg-status');
    if (el) el.textContent = msg;
  }

  function updateSwatch(h, s, b) {
    const { r, g, bl } = hsbToRgb(h, s, b);
    const sw = document.getElementById('dg-swatch');
    const lbl = document.getElementById('dg-hsb');
    if (sw) {
      sw.style.background = `rgb(${r},${g},${bl})`;
      sw.style.display = 'block';
    }
    if (lbl) {
      lbl.textContent = `H${h} S${s} B${b}`;
      lbl.style.display = 'block';
    }
  }

  window.dgDebug = () => {
    const strips = getStrips();
    console.log('[Solver] Play type:', playType);
    console.log('[Solver] Mode:', desiredMode);
    console.log('[Solver] Game mode:', getCurrentMode());
    console.log('[Solver] Strips:', {
      h: getStripValue(strips.h),
      s: getStripValue(strips.s),
      b: getStripValue(strips.b),
    });
    console.log('[Solver] Captured:', capturedH, capturedS, capturedB);
    console.log('[Solver] Countdown color:', getCountdownColor());
    console.log('[Solver] Active screen:', getActiveScreen());
    console.log('[Solver] Game elapsed:', Date.now() - gameStartTime, 'ms');
  };

  window.dgForceSet = (h, s, b) =>
    solveSliders(h ?? capturedH, s ?? capturedS, b ?? capturedB, desiredMode);

  window.dgSetMode = mode => {
    if (['easy', 'hard', 'brutal'].includes(mode)) {
      desiredMode = mode;
      updateModeButtons();
      console.log(`[Solver] Mode set to ${mode}`);
    }
  };

  window.dgSetPlayType = type => {
    if (['solo', 'daily'].includes(type)) {
      playType = type;
      updatePlayButtons();
      console.log(`[Solver] Play type set to ${type}`);
    }
  };

  console.log(
    '[Dialed.gg Solver] v8.2 loaded — dgSetMode("easy"|"hard"|"brutal") dgSetPlayType("solo"|"daily")',
  );
})();