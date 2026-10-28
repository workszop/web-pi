// Mascot: the walking voxel robot from the kiosk demo (vendor/robot.js) replaces the cat.
// Two stages share one frame loop: the empty chat terminal (the robot strolls along the
// bottom and returns under the suggestion bubble) and the model dialog (it paces on the
// dialog's top edge). The bundle's cat elements stay in the DOM, invisible, because its
// layout and visibility logic still measures them.

// ─── Constants ───
const WALK_PX_PER_S = 48;
const WAVE_S = 1.6;
const PAUSE_HOME_S = [3, 6];
const PAUSE_AWAY_S = [1, 2.5];
const WAVE_CHANCE = 0.35;
const MIN_STROLL_PX = 70;
const MAX_DT = 0.05;
const HOME_TOLERANCE_PX = 6;   // the bubble shows while the robot is this close to its home spot
const FOOT_LINE = 0.92;   // fraction of the mascot box height where the old sprite's feet stood

// ─── State ───
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const stages = [];
let audio = null;

// ─── DOM refs ───
const terminal = document.querySelector('#pi-terminal');
const dialog = document.querySelector('#model-dialog');
const setupCat = document.querySelector('.setup-cat');

// ─── Helpers ───
const rand = ([a, b]) => a + Math.random() * (b - a);

function chirp() {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    for (const [i, freq] of [880, 1320, 1760].entries()) {
      const osc = audio.createOscillator(), gain = audio.createGain(), t = now + i * 0.07;
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.07);
    }
  } catch { /* sound is optional */ }
}

// layout() returns { visible, height, homeX, minX, maxX, floorY } in canvas CSS px.
function createStage({ name, host, before, layout }) {
  const canvas = document.createElement('canvas');
  canvas.className = `robot-stage robot-stage-${name}`;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.robot = 'hidden';
  host.insertBefore(canvas, before ?? null);

  let unit = 1;
  const renderer = window.Robot.create({ canvas, model: 'bot', unit: () => unit });
  const baseHeight = renderer.bounds.h;   // standing height in CSS px at 1 px per voxel
  const stage = {
    name, canvas, renderer, layout,
    mode: 'hidden', x: 0, targetX: 0, timer: 0, yaw: 0, height: 0, onShow: null,
    fit(height) {
      if (Math.abs(height - stage.height) < 0.5) return;
      stage.height = height;
      unit = height / baseHeight;
      renderer.resize();
    },
    hit(px, py) {
      const b = renderer.bounds, p = renderer.pose;
      return px >= p.x + b.left && px <= p.x + b.right && py >= p.y + b.top && py <= p.y + b.bottom;
    },
    wave() { stage.mode = 'waving'; stage.timer = WAVE_S; stage.yaw = 0; },
  };
  new ResizeObserver(() => { stage.height = 0; }).observe(canvas);   // forces fit() to resize the backing store
  stages.push(stage);
  return stage;
}

function nextMove(stage, L) {
  const range = L.maxX - L.minX;
  if (reducedMotion.matches || range < MIN_STROLL_PX) {
    stage.mode = 'paused'; stage.timer = rand(PAUSE_HOME_S); stage.yaw = 0;
    return;
  }
  if (Math.abs(stage.x - L.homeX) > 4) stage.targetX = L.homeX;
  else {
    let x;
    do x = L.minX + Math.random() * range; while (Math.abs(x - L.homeX) < MIN_STROLL_PX);
    stage.targetX = x;
  }
  stage.mode = 'walking';
}

function step(stage, dt) {
  const L = stage.layout();
  const { canvas, renderer } = stage;
  if (!L.visible) {
    if (stage.mode !== 'hidden') { renderer.clear(); stage.mode = 'hidden'; canvas.dataset.robot = 'hidden'; }
    return;
  }
  stage.fit(L.height);
  if (stage.mode === 'hidden') {
    stage.x = L.homeX; stage.mode = 'paused'; stage.timer = 0.6; stage.yaw = 0;
    stage.onShow?.();
  }
  stage.x = Math.min(L.maxX, Math.max(L.minX, stage.x));

  let walking = false;
  if (stage.mode === 'walking') {
    const dx = stage.targetX - stage.x, move = WALK_PX_PER_S * dt;
    if (Math.abs(dx) <= move) {
      stage.x = stage.targetX;
      const home = Math.abs(stage.x - L.homeX) < 4;
      stage.mode = 'paused'; stage.timer = rand(home ? PAUSE_HOME_S : PAUSE_AWAY_S); stage.yaw = 0;
      if (Math.random() < WAVE_CHANCE) stage.wave();
    } else {
      stage.x += Math.sign(dx) * move;
      stage.yaw = Math.sign(dx) * renderer.WALK_YAW - renderer.CAM_YAW;
      walking = true;
    }
  } else {
    stage.timer -= dt;
    if (stage.timer <= 0) {
      if (stage.mode === 'waving') { stage.mode = 'paused'; stage.timer = rand(PAUSE_AWAY_S); }
      else nextMove(stage, L);
    }
  }

  renderer.pose.x = stage.x;
  renderer.pose.y = L.floorY;
  renderer.animate(dt, { walking, waving: stage.mode === 'waving', stretching: false, airborne: false, yawTarget: stage.yaw });
  renderer.clear();
  renderer.draw();
  canvas.dataset.robot = stage.mode;
  canvas.dataset.robotX = String(Math.round(stage.x));
  canvas.dataset.robotRange = `${Math.round(L.minX)}-${Math.round(L.maxX)}`;
  stage.afterStep?.(L);
}

// ─── Stages ───
// Right edge (viewport px) of terminal text in the rows the robot would walk in front of.
function textEdge(top, bottom) {
  let edge = -Infinity;
  for (const row of terminal.querySelectorAll('.xterm-rows > div')) {
    const r = row.getBoundingClientRect(), len = row.textContent.trimEnd().length;
    if (!len || r.bottom <= top || r.bottom > bottom) continue;
    edge = Math.max(edge, r.left + len * (r.width / row.textContent.length));
  }
  return edge;
}

function terminalStage(mascot) {
  const box = mascot.querySelector('.mascot-cat');
  let edgeCache = { at: 0, value: -Infinity };
  const stage = createStage({
    name: 'terminal', host: terminal, before: mascot,
    layout() {
      const visible = !mascot.hidden && mascot.style.visibility !== 'hidden' && box.offsetWidth > 0;
      if (!visible) return { visible };
      const host = terminal.getBoundingClientRect(), r = box.getBoundingClientRect();
      const height = r.height * 0.92, half = height * 0.4;
      const floor = r.top + r.height * FOOT_LINE;   // where the cat sprite's feet were: on the rule line
      const now = performance.now();
      if (now - edgeCache.at > 250) edgeCache = { at: now, value: textEdge(floor - height, floor + 2) };
      const homeX = r.left - host.left + r.width / 2;
      const minX = Math.max(half + 12, edgeCache.value - host.left + half + 8);
      return { visible, height, homeX, minX: Math.min(minX, homeX), maxX: homeX, floorY: floor - host.top };
    },
  });
  // The suggestion bubble belongs to the robot's home spot (bottom right): it shows only while the robot is there.
  stage.afterStep = L => {
    const home = String(Math.abs(stage.x - L.homeX) < HOME_TOLERANCE_PX);
    if (mascot.dataset.robotHome !== home) mascot.dataset.robotHome = home;
  };
  // The canvas ignores pointer events so the terminal keeps working; hit-test the robot here.
  terminal.addEventListener('pointerdown', event => {
    if (stage.mode === 'hidden') return;
    const host = terminal.getBoundingClientRect();
    if (!stage.hit(event.clientX - host.left, event.clientY - host.top)) return;
    event.preventDefault();
    event.stopPropagation();
    chirp();
    stage.wave();
  }, true);
}

function dialogStage() {
  const stage = createStage({
    name: 'dialog', host: dialog,
    layout() {
      const visible = dialog.open && dialog.offsetWidth > 0;
      if (!visible) return { visible };
      const rise = -setupCat.offsetTop;   // the space the bundle reserves above the dialog for the cat
      const width = stage.canvas.clientWidth, height = Math.max(36, rise * 0.98);
      const inset = parseFloat(getComputedStyle(dialog).borderTopLeftRadius) + height * 0.35;
      return { visible, height, homeX: width - inset, minX: inset, maxX: width - inset, floorY: stage.canvas.clientHeight - 2 };
    },
  });
  stage.onShow = () => stage.wave();   // greet when the dialog opens
  stage.canvas.addEventListener('pointerdown', event => {
    const r = stage.canvas.getBoundingClientRect();
    if (!stage.hit(event.clientX - r.left, event.clientY - r.top)) return;
    event.preventDefault();
    chirp();
    stage.wave();
  });
}

function whenMascot(callback) {
  const found = terminal.querySelector('.empty-mascot');
  if (found) return callback(found);
  const observer = new MutationObserver(() => {
    const mascot = terminal.querySelector('.empty-mascot');
    if (mascot) { observer.disconnect(); callback(mascot); }
  });
  observer.observe(terminal, { childList: true, subtree: true });
}

// ─── Init ───
if (window.Robot && terminal) {
  whenMascot(terminalStage);
  if (dialog && setupCat) dialogStage();
  let last = performance.now();
  const frame = now => {
    const dt = Math.min(MAX_DT, (now - last) / 1000);
    last = now;
    for (const stage of stages) step(stage, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
