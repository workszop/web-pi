/* ROBOT - voxel (3D block) robots rendered smoothly on a full-resolution canvas + a stage director for the kiosk (the robot stays in front of the cards).
   Loaded by index.html; kiosk-core.js turns the robot, the cat and the heroes on from the settings popover.
   API:  Robot.create({ canvas, model, unit })  -> renderer   (pose in CSS px, feet anchor; unit = CSS px per voxel, a number or a function re-read on resize())
         Robot.kiosk({ renderer, stage, view, bubble, remarks, cardSelector, speed, walkSpeed, bounds, ticker }) -> director
         (speed: optional () => number, the kiosk tempo multiplier; walking, waiting and hopping scale with it;
          walkSpeed: px/s or () => px/s; bounds: () => {left, top, right, bottom, width, height} of the stage area in canvas space, default the viewport;
          origin: () => {left, top} viewport offset of the canvas (card rects are translated by it); scale: () => stage scale for the card-size threshold;
          ticker: optional { add(fn(dt)) } shared frame loop; without it the director runs its own requestAnimationFrame loop) */
window.Robot = (function () {
  "use strict";
  // ─── Constants ───
  const CAM_YAW = -0.28, CAM_PITCH = 0.42;
  const WALK_YAW = 0.8;                       // turn toward walking direction, relative to the camera
  const STEP_HZ = 2.1, LEG_AMP = 0.62, ARM_AMP = 0.5;
  const TURN_SPEED = 5, BLEND_SPEED = 7, STRETCH_SPEED = 2.2;
  const CY = Math.cos(CAM_YAW), SY = Math.sin(CAM_YAW);
  const CP = Math.cos(CAM_PITCH), SP = Math.sin(CAM_PITCH);
  const LIGHT = normalize([-0.45, 1.0, 0.8]);
  const DEFAULT_PALETTE = {
    body: '#F1F0EC', dark: '#8E97A6', metal: '#4B5563', pink: '#d20757', berry: '#8A004C',
    teal: '#0E9F8E', eye: '#7FF5E8', eyeOff: '#1E3140', shadow: 'rgba(0,0,0,0.45)',
    // heroes (easter eggs)
    red: '#C8102E', gold: '#E3B341', green: '#3FA34D', greenDark: '#1F6B33', black: '#15181F', white: '#F7F7F5', tan: '#D9A066', brown: '#5B3A1E',
  };
  const CORNERS = Array.from({ length: 8 }, (_, i) => [i & 4 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 1 ? 0.5 : -0.5]);
  const FACES = [
    { n: [1, 0, 0],  c: [0b100, 0b110, 0b111, 0b101] },
    { n: [-1, 0, 0], c: [0b000, 0b010, 0b011, 0b001] },
    { n: [0, 1, 0],  c: [0b010, 0b110, 0b111, 0b011] },
    { n: [0, -1, 0], c: [0b000, 0b100, 0b101, 0b001] },
    { n: [0, 0, 1],  c: [0b001, 0b101, 0b111, 0b011] },
    { n: [0, 0, -1], c: [0b000, 0b100, 0b110, 0b010] },
  ];

  // ─── Models (model space: +z = face, +y = up, x = sideways) ───
  // A part has a pivot [py, pz] for swinging around the X axis and a role that picks its animation:
  // legL / legR (walk cycle, opposite phase) · armL / armR (counter-swing, armR also waves) · tail (wag) · none
  function part(py, pz, role) { return { pivot: [py, pz], role: role || 'none', vox: new Map() }; }
  function set(p, x, y, z, c, ext) { p.vox.set(`${x},${y},${z}`, { x, y, z, c, ext }); }   // ext: voxel shows only once pose.stretchA exceeds it
  function box(p, x0, x1, y0, y1, z0, z1, c) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(p, x, y, z, c);
  }

  // base robot; `variant` = 'f' adds the female styling (lashes, bow antenna, side panels, skirt flare)
  function buildBot(variant) {
    const f = variant === 'f';
    const head = part(10, 0);
    box(head, -2, 2, 10, 14, -2, 2, 'body');
    box(head, -1, 1, 12, 12, 2, 2, 'dark');
    set(head, -1, 12, 2, 'eye'); set(head, 1, 12, 2, 'eye');
    if (f) { set(head, -1, 13, 2, 'dark'); set(head, 1, 13, 2, 'dark'); }             // lashes
    if (f) { box(head, -3, -3, 11, 13, -1, 1, 'berry'); box(head, 3, 3, 11, 13, -1, 1, 'berry'); }   // side panels
    else { set(head, -3, 12, 0, 'metal'); set(head, 3, 12, 0, 'metal'); }
    box(head, -1, 1, 14, 14, -1, 1, 'dark');
    set(head, 0, 15, 0, 'metal');
    if (f) { set(head, -1, 16, 0, 'pink'); set(head, 0, 16, 0, 'berry'); set(head, 1, 16, 0, 'pink'); }   // bow
    else set(head, 0, 16, 0, 'tip');
    const body = part(5, 0);
    box(body, -2, 2, 5, 9, -1, 1, 'body');
    box(body, -2, 2, 5, 5, -1, 1, f ? 'pink' : 'dark');
    box(body, -1, 1, 6, 8, 1, 1, f ? 'teal' : 'berry');
    set(body, 0, 7, 1, 'pink');
    set(body, 0, 9, 0, 'metal');
    if (f) box(body, -3, 3, 4, 4, -2, 2, 'berry');                                           // skirt flare
    const armL = part(9.5, 0, 'armL'), armR = part(9.5, 0, 'armR');
    box(armL, -4, -3, 5, 9, -1, 0, 'dark'); box(armL, -4, -3, 9, 9, -1, 0, 'metal'); box(armL, -4, -3, 4, 4, -1, 0, 'pink');
    box(armR, 3, 4, 5, 9, -1, 0, 'dark');   box(armR, 3, 4, 9, 9, -1, 0, 'metal');   box(armR, 3, 4, 4, 4, -1, 0, 'pink');
    const legL = part(5, 0, 'legL'), legR = part(5, 0, 'legR');
    box(legL, -2, -1, 1, f ? 3 : 4, -1, 0, 'dark'); box(legL, -2, -1, 0, 0, -1, 1, 'metal');
    box(legR, 1, 2, 1, f ? 3 : 4, -1, 0, 'dark');   box(legR, 1, 2, 0, 0, -1, 1, 'metal');
    return { parts: { body, head, legL, legR, armL, armR }, height: 17, shadow: 5.5, walkYaw: 0.8 };
  }

  // robot cat: horizontal body along z (face toward the viewer), four legs, wagging tail, collar
  function buildCat() {
    const body = part(3, 0);
    box(body, -1, 1, 3, 5, -3, 2, 'body');
    set(body, -1, 5, -1, 'dark'); set(body, 1, 5, -2, 'dark'); set(body, 0, 5, 0, 'dark'); set(body, 0, 5, -3, 'dark');   // stripes
    box(body, -1, 1, 5, 5, 1, 1, 'teal');                                                  // collar
    set(body, 0, 4, 2, 'pink');                                                           // collar tag
    const head = part(5, 3);
    box(head, -2, 2, 5, 8, 2, 4, 'body');
    set(head, -1, 7, 4, 'eye'); set(head, 1, 7, 4, 'eye');
    set(head, 0, 6, 4, 'pink');                                                           // nose
    set(head, -2, 6, 4, 'dark'); set(head, 2, 6, 4, 'dark');                              // cheeks
    box(head, -2, -2, 9, 10, 3, 3, 'body'); box(head, 2, 2, 9, 10, 3, 3, 'body');          // ears
    set(head, -2, 9, 4, 'pink'); set(head, 2, 9, 4, 'pink');                              // inner ears
    const legs = {
      legFL: part(3, 1.5, 'legL'), legBR: part(3, -1.5, 'legL'),
      legFR: part(3, 1.5, 'legR'), legBL: part(3, -1.5, 'legR'),
    };
    const at = { legFL: [-1, 1], legBR: [1, -2], legFR: [1, 1], legBL: [-1, -2] };
    for (const k in legs) { const [x, z] = at[k]; box(legs[k], x, x, 1, 2, z, z, 'body'); set(legs[k], x, 0, z, 'dark'); }
    const tail = part(4.5, -3.5, 'tail');
    set(tail, 0, 4, -4, 'body'); set(tail, 0, 5, -4, 'body'); set(tail, 0, 6, -5, 'body'); set(tail, 0, 7, -5, 'dark');
    set(tail, 0, 8, -6, 'body', 0.3); set(tail, 0, 9, -6, 'body', 0.55); set(tail, 0, 10, -7, 'dark', 0.8);   // the tail grows while stretching
    // stretch: front legs reach forward, head dips, rear rises, tail up (angles blended in by pose.stretchA)
    body.stretch = 0.22; head.stretch = -0.1; legs.legFL.stretch = legs.legFR.stretch = -0.55; tail.stretch = 0.5;
    return { parts: Object.assign({ body, head, tail }, legs), height: 11, shadow: 4.5, walkYaw: 1.1 };
  }

  // easter-egg heroes: same humanoid rig as the bot (head, body, two arms, two legs), different colours and props
  function buildHero(kind) {
    const head = part(10, 0), body = part(5, 0);
    const armL = part(9.5, 0, 'armL'), armR = part(9.5, 0, 'armR');
    const legL = part(5, 0, 'legL'), legR = part(5, 0, 'legR');
    if (kind === 'tarzan') {                                                                                                                             // bare chest, long hair, leopard loincloth, barefoot
      box(head, -2, 2, 10, 14, -2, 2, 'tan');
      box(head, -2, 2, 14, 14, -2, 2, 'brown'); box(head, -2, 2, 12, 13, -2, -2, 'brown'); box(head, -2, -2, 12, 13, -2, 1, 'brown'); box(head, 2, 2, 12, 13, -2, 1, 'brown');   // hair down to the shoulders
      set(head, -1, 12, 2, 'black'); set(head, 1, 12, 2, 'black'); box(head, -1, 1, 10, 10, 2, 2, 'brown');                                              // eyes, mouth
      box(body, -2, 2, 6, 9, -1, 1, 'tan');
      box(body, -2, 2, 5, 5, -1, 1, 'gold'); set(body, -1, 5, 1, 'brown'); set(body, 1, 5, -1, 'brown'); set(body, 2, 5, 0, 'brown');                   // loincloth with spots
      box(armL, -4, -3, 5, 9, -1, 0, 'tan'); box(armR, 3, 4, 5, 9, -1, 0, 'tan');
      box(legL, -2, -1, 1, 4, -1, 0, 'tan'); box(legL, -2, -1, 4, 4, -1, 0, 'gold'); set(legL, -1, 4, 0, 'brown');
      box(legR, 1, 2, 1, 4, -1, 0, 'tan');   box(legR, 1, 2, 4, 4, -1, 0, 'gold');   set(legR, 2, 4, -1, 'brown');
      return { parts: { body, head, legL, legR, armL, armR }, height: 17, shadow: 5.5, walkYaw: 0.8 };
    }
    if (kind === 'zorro') {                                                                                                                              // all black, wide-brimmed hat, mask, red sash, sabre in the right hand
      box(head, -2, 2, 10, 14, -2, 2, 'tan');
      box(head, -2, 2, 12, 13, -2, 2, 'black'); set(head, -1, 12, 2, 'white'); set(head, 1, 12, 2, 'white');                                             // mask with eye holes
      box(head, -2, 2, 14, 14, -2, 2, 'black'); box(head, -3, 3, 15, 15, -3, 3, 'black'); box(head, -2, 2, 16, 17, -2, 2, 'black');                       // brim and crown
      box(body, -2, 2, 6, 9, -1, 1, 'black'); box(body, -2, 2, 5, 5, -1, 1, 'red');
      box(armL, -4, -3, 5, 9, -1, 0, 'black'); box(armR, 3, 4, 5, 9, -1, 0, 'black');
      box(armR, 3, 4, 5, 5, -1, 0, 'tan'); set(armR, 5, 5, 0, 'gold'); box(armR, 6, 10, 5, 5, 0, 0, 'metal'); set(armR, 11, 5, 0, 'white');         // hand, guard, sabre held out sideways, tip
      box(legL, -2, -1, 1, 4, -1, 0, 'black'); box(legL, -2, -1, 0, 0, -1, 1, 'brown');
      box(legR, 1, 2, 1, 4, -1, 0, 'black');   box(legR, 1, 2, 0, 0, -1, 1, 'brown');
      return { parts: { body, head, legL, legR, armL, armR }, height: 18, shadow: 5.5, walkYaw: 0.8 };
    }
    // robin: green tunic and pointed hat with a red feather, brown belt and boots (bow and arrow are drawn on the canvas by the kiosk)
    box(head, -2, 2, 10, 14, -2, 2, 'tan');
    set(head, -1, 12, 2, 'black'); set(head, 1, 12, 2, 'black'); box(head, -1, 1, 10, 10, 2, 2, 'brown');                                                // eyes, beard line
    box(head, -2, 2, 14, 14, -2, 2, 'green'); box(head, -1, 1, 15, 15, -1, 1, 'green'); set(head, 0, 16, 0, 'green');                                   // pointed hat
    set(head, 2, 15, 0, 'red'); set(head, 3, 16, 0, 'red');                                                                                              // feather
    box(body, -2, 2, 6, 9, -1, 1, 'green'); box(body, -2, 2, 5, 5, -1, 1, 'brown'); set(body, 0, 5, 1, 'gold');                                          // tunic, belt, buckle
    box(armL, -4, -3, 5, 9, -1, 0, 'green'); box(armL, -4, -3, 5, 5, -1, 0, 'tan');
    box(armR, 3, 4, 5, 9, -1, 0, 'green');   box(armR, 3, 4, 5, 5, -1, 0, 'tan');
    box(legL, -2, -1, 1, 4, -1, 0, 'greenDark'); box(legL, -2, -1, 0, 1, -1, 1, 'brown');
    box(legR, 1, 2, 1, 4, -1, 0, 'greenDark');   box(legR, 1, 2, 0, 1, -1, 1, 'brown');
    return { parts: { body, head, legL, legR, armL, armR }, height: 17, shadow: 5.5, walkYaw: 0.8 };
  }

  const MODELS = { bot: () => buildBot(), 'bot-f': () => buildBot('f'), cat: () => buildCat(), tarzan: () => buildHero('tarzan'), zorro: () => buildHero('zorro'), robin: () => buildHero('robin') };
  // named limb poses (target angles), blended in by pose.poseA when animate() gets input.pose
  const POSES = {
    hang: { armL: -3.0, armR: -3.0, legL: 0.25, legR: -0.25 },   // both arms up, holding the vine
    fly:  { armL: 0.55, armR: 0.55, legL: 0, legR: 0 },           // arms swept back
    guard: { armL: 0.3, armR: -0.7, legL: 0.15, legR: -0.15 },   // sabre held low in front
    slash: { armL: 0.4, armR: -1.9, legL: 0.25, legR: -0.25 },   // sabre swung forward-up
    aim:  { armL: -1.6, armR: -1.1, legL: 0.15, legR: -0.15 },   // bow arm straight out, string hand drawn back to the cheek
  };

  // ─── Helpers ───
  function normalize(v) { const l = Math.hypot(...v); return v.map(a => a / l); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function hexRgb(h) { h = h.trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
  function cam(x, y, z) {           // world -> [screenX, screenY, depth]; depth grows toward the viewer
    const x1 = x * CY + z * SY, z1 = -x * SY + z * CY;
    return [x1, -(y * CP - z1 * SP), y * SP + z1 * CP];
  }
  // swing a part around the X axis at its pivot (limbs rotate freely; the cube itself is rotated too, see geometry())
  function addPart(out, p, angle, stretchA) {
    const [py, pz] = p.pivot, ca = Math.cos(angle), sa = Math.sin(angle);
    for (const v of p.vox.values()) {
      if (v.ext && !(stretchA > v.ext)) continue;
      if (angle === 0) { out.push(v); continue; }
      const dy = v.y + 0.5 - py, dz = v.z + 0.5 - pz;
      out.push({ x: v.x, y: py + dy * ca - dz * sa - 0.5, z: pz + dy * sa + dz * ca - 0.5, c: v.c, rot: angle });
    }
  }

  // ─── Renderer ───
  function create(opts) {
    const canvas = opts.canvas, ctx = canvas.getContext('2d');
    const DPR = window.devicePixelRatio || 1;
    const unitOf = typeof opts.unit === 'function' ? opts.unit : () => opts.unit || 9;   // unit: CSS px per voxel, re-read on resize
    let unit = unitOf();
    const MODEL = (MODELS[opts.model] || MODELS.bot)();
    const css = getComputedStyle(document.documentElement);
    const PAL = {};
    for (const k in DEFAULT_PALETTE) {
      const tok = css.getPropertyValue('--robot-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())).trim();
      PAL[k] = k === 'shadow' ? (tok || DEFAULT_PALETTE[k]) : hexRgb(tok || DEFAULT_PALETTE[k]);
    }
    PAL.tip = PAL.pink;
    const shadeCache = {};
    function shaded(key, level) {
      const id = key + level;
      if (!shadeCache[id]) { const c = PAL[key]; shadeCache[id] = `rgb(${(c[0] * level) | 0},${(c[1] * level) | 0},${(c[2] * level) | 0})`; }
      return shadeCache[id];
    }
    function levelOf(lum) { return Math.round((0.55 + 0.45 * (0.5 + 0.5 * clamp(lum, -1, 1))) * 100) / 100; }

    // pose: x, y = feet anchor in CSS px; lift = height above the anchor in voxels (jump)
    const pose = { x: 0, y: 0, lift: 0, yaw: 0, pitch: 0, walkBlend: 0, phase: 0, waveA: 0, stretchA: 0, poseA: 0, poseName: null, airborne: false, eyesClosed: false, t: 0, nextBlink: 2, visible: true, shadow: true };
    // pitch: lean of the whole figure around its centre (forward = negative); shadow: false for figures in the air
    let W = 0, H = 0;

    // screen-space bounds of the standing robot (CSS px, relative to the feet anchor); refreshed by resize() when the unit changes
    const base = (() => {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of Object.values(MODEL.parts)) for (const v of p.vox.values()) for (const o of CORNERS) {
        if (v.ext) continue;   // stretch-only voxels do not count toward the standing size
        const q = cam(v.x + 0.5 + o[0], v.y + 0.5 + o[1], v.z + 0.5 + o[2]);
        x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
      }
      return { x0, x1, y0, y1 };
    })();
    const bounds = {};
    function measure() {
      unit = unitOf();
      Object.assign(bounds, { left: base.x0 * unit, right: base.x1 * unit, top: base.y0 * unit, bottom: base.y1 * unit, w: (base.x1 - base.x0) * unit, h: (base.y1 - base.y0) * unit });
    }
    measure();

    function resize() {
      measure();
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * DPR; canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    function clear() { ctx.clearRect(0, 0, W, H); }

    // advance animation blends; input = { walking, waving, stretching, airborne, yawTarget, pose (name from POSES) }
    function animate(dt, input) {
      pose.t += dt;
      pose.yaw += (input.yawTarget - pose.yaw) * Math.min(1, TURN_SPEED * dt);
      pose.walkBlend = clamp(pose.walkBlend + (input.walking ? 1 : -1) * BLEND_SPEED * dt, 0, 1);
      if (input.walking || pose.walkBlend > 0) pose.phase += dt * STEP_HZ * Math.PI * 2;
      pose.waveA = clamp(pose.waveA + (input.waving ? 1 : -1) * BLEND_SPEED * dt, 0, 1);
      pose.stretchA = clamp(pose.stretchA + (input.stretching ? 1 : -1) * STRETCH_SPEED * dt, 0, 1);
      if (input.pose && POSES[input.pose]) pose.poseName = input.pose;
      pose.poseA = clamp(pose.poseA + (input.pose ? 1 : -1) * BLEND_SPEED * dt, 0, 1);
      pose.airborne = !!input.airborne;
      if (pose.t > pose.nextBlink) { pose.eyesClosed = !pose.eyesClosed; pose.nextBlink = pose.t + (pose.eyesClosed ? 0.12 : rand(2.2, 4.5)); }
    }

    function buildPose() {
      const out = [], swing = Math.sin(pose.phase) * pose.walkBlend;
      let legL = swing * LEG_AMP, legR = -swing * LEG_AMP, armL = -swing * ARM_AMP, armR = swing * ARM_AMP;
      if (pose.airborne) { legL = legR = 0.55; armL = armR = -1.3; }
      if (pose.poseA > 0 && POSES[pose.poseName]) {
        const P = POSES[pose.poseName], a = pose.poseA, mix = (v, t) => v * (1 - a) + t * a;
        legL = mix(legL, P.legL); legR = mix(legR, P.legR); armL = mix(armL, P.armL); armR = mix(armR, P.armR);
      }
      if (pose.waveA > 0) armR = -(2.5 + Math.sin(pose.t * 14) * 0.35) * pose.waveA;
      const tail = Math.sin(pose.t * 4) * 0.35 + pose.waveA * 0.6 + (pose.airborne ? 0.5 : 0);
      const angles = { legL, legR, armL, armR, tail, none: 0 }, s = pose.stretchA;
      for (const p of Object.values(MODEL.parts)) {
        let a = angles[p.role] || 0;
        if (s > 0 && p.stretch !== undefined) a = a * (1 - s) + p.stretch * s;
        addPart(out, p, a, s);
      }
      return out;
    }

    // clips: array of {left, top, width, height, radius?} in CSS px that occlude the robot (it is "behind" them)
    function draw(clips) {
      if (!pose.visible) return;
      ctx.save();
      if (clips && clips.length) {
        ctx.beginPath(); ctx.rect(0, 0, W, H);
        for (const r of clips) ctx.roundRect(r.left, r.top, r.width, r.height, r.radius || 0);
        ctx.clip('evenodd');
      }
      const ox = pose.x, oy = pose.y;
      // shadow
      if (pose.shadow) {
        const k = clamp(1 - pose.lift / 20, 0.35, 1);
        ctx.fillStyle = PAL.shadow; ctx.beginPath();
        ctx.ellipse(ox, oy, MODEL.shadow * unit * k, MODEL.shadow * unit * SP * k, 0, 0, Math.PI * 2); ctx.fill();
      }
      // voxels
      const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw), cp = Math.cos(pose.pitch), sp2 = Math.sin(pose.pitch);
      const hc = MODEL.height * 0.5;   // pitch pivots around the figure's centre
      const rot = (x, y, z) => { const y1 = y * cp - z * sp2, z1 = y * sp2 + z * cp; return [x * cy + z1 * sy, y1, -x * sy + z1 * cy]; };   // pitch in model space (positive = lean forward), then yaw
      // per limb-angle geometry cache: corner offsets + face visibility/shade (angle 0 = body/head)
      const geo = {};
      function geometry(angle) {
        if (geo[angle]) return geo[angle];
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const swing = (x, y, z) => [x, y * ca - z * sa, y * sa + z * ca];      // limb rotation around X
        const offs = CORNERS.map(o => { const p = cam(...rot(...swing(...o))); return [p[0] * unit, p[1] * unit]; });
        const faces = FACES.map(f => {
          const w = rot(...swing(...f.n)), lum = w[0] * LIGHT[0] + w[1] * LIGHT[1] + w[2] * LIGHT[2];
          return { on: cam(...w)[2] > 0.001, level: levelOf(lum), c: f.c };
        });
        return (geo[angle] = { offs, faces });
      }
      const bob = pose.walkBlend * (Math.abs(Math.sin(pose.phase)) - 0.5) * 0.5 - pose.stretchA * 0.4;   // stretching: chest sinks a little
      const items = [];
      for (const v of buildPose()) {
        const w = rot(v.x + 0.5, v.y + 0.5 - hc, v.z + 0.5);
        const p = cam(w[0], w[1] + hc + pose.lift + bob, w[2]);
        let c = v.c;
        if (c === 'eye' && pose.eyesClosed) c = 'eyeOff';
        if (c === 'tip') c = Math.floor(pose.t * 2) % 2 ? 'pink' : 'teal';
        items.push({ x: ox + p[0] * unit, y: oy + p[1] * unit, d: p[2], c, g: geometry(v.rot || 0) });
      }
      items.sort((a, b) => a.d - b.d);
      for (const it of items) for (const f of it.g.faces) {
        if (!f.on) continue;
        ctx.fillStyle = shaded(it.c, f.level); ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const o = it.g.offs[f.c[i]];
          i ? ctx.lineTo(it.x + o[0], it.y + o[1]) : ctx.moveTo(it.x + o[0], it.y + o[1]);
        }
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.stroke();   // hide anti-aliasing seams between cubes
      }
      ctx.restore();
    }

    function headTop() { const p = cam(0, MODEL.height + 2 + pose.lift, 0); return [pose.x + p[0] * unit, pose.y + p[1] * unit]; }
    // model-space point (voxel units, before yaw/pitch) -> screen CSS px, with the current yaw, pitch and lift applied
    function project(x, y, z) {
      const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw), cp = Math.cos(pose.pitch), sp2 = Math.sin(pose.pitch), hc = MODEL.height * 0.5;
      const y1 = (y - hc) * cp - z * sp2, z1 = (y - hc) * sp2 + z * cp;
      const p = cam(x * cy + z1 * sy, y1 + hc + pose.lift, -x * sy + z1 * cy);
      return [pose.x + p[0] * unit, pose.y + p[1] * unit];
    }

    resize();
    return { pose, bounds, get unit() { return unit; }, model: opts.model || 'bot', ctx, height: MODEL.height, resize, clear, animate, draw, headTop, project, WALK_YAW: MODEL.walkYaw || WALK_YAW, CAM_YAW };
  }

  // ─── Kiosk director: strolls in front of the stage cards ───
  const CLAIMS = new Map();      // card element -> director id, so two robots do not pick the same card
  let directorSeq = 0;
  function kiosk(opts) {
    const ME = ++directorSeq;
    const R = opts.renderer, pose = R.pose;
    const stage = document.querySelector(opts.stage || '#stage');
    const viewEl = document.querySelector(opts.view || '#kView');
    const bubble = opts.bubble;
    const REMARKS = opts.remarks || {};
    const SEL = opts.cardSelector || '.fl-node, .card, .dy-page, .pa-wave, .pa-script, .pa-docs';
    const walkPx = typeof opts.walkSpeed === 'function' ? opts.walkSpeed : () => opts.walkSpeed || 170;   // CSS px per second
    const area = opts.bounds || (() => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight }));
    const origin = opts.origin || (() => ({ left: 0, top: 0 }));   // viewport offset of the canvas: card rects are translated into canvas space
    const scaleOf = typeof opts.scale === 'function' ? opts.scale : () => 1;   // stage scale; the card-size threshold scales with it
    const ENTER = opts.enterSide === 'right' ? 1 : -1;
    const RB = R.bounds;   // robot size in px, refreshed in place by R.resize(); RB.w = width
    const tempo = typeof opts.speed === 'function' ? opts.speed : () => 1;

    const S = { cards: [], layer: 'front', product: null, remarkIx: 0, gen: null, action: null, bubbleUntil: 0, bubbleHalf: 0, said: 0, jump: null, t: 0 };

    function scanCards() {
      const list = [], o = origin(), min = 40 * scaleOf();
      viewEl.querySelectorAll(SEL).forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < min || r.height < min) return;
        list.push({ el, left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top, width: r.width, height: r.height });
      });
      S.cards = list;
    }
    function free(c) { const who = CLAIMS.get(c.el); return !who || who === ME; }
    function claim(c) { release(); if (c) CLAIMS.set(c.el, ME); }
    function release() { for (const [el, who] of CLAIMS) if (who === ME) CLAIMS.delete(el); }
    function remark() {
      const list = REMARKS[S.product] || REMARKS.default || [];
      if (!list.length) return null;
      return list[S.remarkIx++ % list.length];
    }
    function say(text, seconds) {
      if (!bubble || !text) return;
      bubble.textContent = text; bubble.classList.add('on');
      S.bubbleHalf = bubble.offsetWidth / 2 + 12 * scaleOf();   // measured once per remark, not every frame
      S.bubbleUntil = S.t + seconds;
    }

    // actions (consumed by the generator script)
    const move = (x, y, o) => ({ type: 'move', x, y, speed: (o && o.speed) || walkPx(), walk: !o || o.walk !== false, face: o && o.face });
    const wait = s => ({ type: 'wait', s });
    const layer = l => ({ type: 'layer', l });
    const teleport = (x, y) => ({ type: 'teleport', x, y });
    const wave = (text, s) => ({ type: 'wave', text, s });
    const hop = () => ({ type: 'hop' });

    function* life() {
      scanCards();
      // enter from the left edge, in front of everything, along the lowest card bottom
      const ground = () => { const a = area(); return (S.cards.length ? Math.max(...S.cards.map(c => c.bottom)) : a.top + a.height * 0.7) + 4; };
      yield layer('front');
      yield teleport(ENTER < 0 ? area().left - RB.w : area().right + RB.w, ground());
      const freeCards = S.cards.filter(free);
      let target = freeCards.length ? pick(freeCards) : null;
      claim(target);
      { const a = area(); yield move(target ? clamp(target.left + target.width * 0.5, a.left + RB.w, a.right - RB.w) : a.left + a.width * 0.5, ground()); }
      yield wave(remark(), 2.6);
      // stays in front of the cards: strolls from card to card along the ground, remarks, hops, waits
      while (true) {
        scanCards();
        const gy = ground();
        const cards = S.cards.filter(free), a = area();
        let x;
        if (cards.length && Math.random() < 0.7) {
          const c = pick(cards);
          claim(c);
          x = clamp(c.left + c.width * rand(0.25, 0.75), a.left + RB.w, a.right - RB.w);
        } else {
          release();
          x = rand(a.left + RB.w * 1.2, a.right - RB.w * 1.2);
        }
        yield move(x, gy);
        if (Math.random() < 0.35) yield hop();
        yield wave(remark(), 2.6);
        yield wait(rand(0.8, 2.2));
      }
    }

    function restart() {
      release(); S.gen = life(); S.action = null; S.jump = null; pose.lift = 0; pose.waveA = 0;
      S.bubbleUntil = 0; if (bubble) bubble.classList.remove('on');   // a remark cut short must not reappear on the next start
    }

    function update(dt) {
      const real = dt;
      dt *= tempo();   // movement and waits follow the kiosk tempo; the renderer's own animation runs on real time
      S.t += dt;
      const product = stage.getAttribute('data-product');
      if (product !== S.product) { S.product = product; S.remarkIx = 0; restart(); }
      if (!S.action) { const n = S.gen.next(); S.action = n.value; S.actionT = 0; }
      const a = S.action; S.actionT += dt;
      let walking = false, waving = false, yawTarget = 0, done = false;
      switch (a.type) {
        case 'teleport': pose.x = a.x; pose.y = a.y; done = true; break;
        case 'layer': S.layer = a.l; done = true; break;
        case 'wait': done = S.actionT >= a.s; break;
        case 'wave': waving = true; if (!a.said) { a.said = true; say(a.text, a.s); } done = S.actionT >= a.s; break;
        case 'hop':
          if (!S.jump) S.jump = { v: 19 };
          S.jump.v -= 70 * dt; pose.lift += S.jump.v * dt;
          if (pose.lift <= 0) { pose.lift = 0; S.jump = null; done = true; }
          break;
        case 'move': {
          const dx = a.x - pose.x, dy = a.y - pose.y, d = Math.hypot(dx, dy), step = a.speed * dt;
          if (d <= step) { pose.x = a.x; pose.y = a.y; done = true; }
          else { pose.x += dx / d * step; pose.y += dy / d * step; }
          walking = a.walk;
          if (a.face !== undefined && a.face !== null) yawTarget = a.face;
          else yawTarget = Math.abs(dx) > 2 ? Math.sign(dx) * R.WALK_YAW - R.CAM_YAW : 0;
          break;
        }
      }
      if (done) S.action = null;
      R.animate(real, { walking, waving, airborne: !!S.jump, yawTarget });
      if (S.bubbleUntil && S.t > S.bubbleUntil) { bubble.classList.remove('on'); S.bubbleUntil = 0; }
      stage.setAttribute(opts.stateAttr || 'data-robot', a.type + ':' + S.layer + ':' + Math.round(pose.x) + ',' + Math.round(pose.y));
    }

    // cards are rescanned by life() before each move (and by restart() on product change / resize); no per-frame layout reads here
    function render() {
      R.clear();
      R.draw(null);
      if (bubble && S.bubbleUntil) { const [hx, hy] = R.headTop(), half = S.bubbleHalf || 0, a = area(); bubble.style.left = clamp(hx, a.left + half, a.right - half) + 'px'; bubble.style.top = Math.max(hy, a.top + 40 * scaleOf()) + 'px'; }
    }

    function step(dt) { if (pose.visible) { update(dt); render(); } }   // switched off: no card scanning, no drawing
    addEventListener('resize', () => { R.resize(); restart(); });
    restart();
    if (opts.ticker) opts.ticker.add(step);   // shared rAF loop from the host
    else { let last = performance.now(); (function frame(now) { step(Math.min(0.05, (now - last) / 1000)); last = now; requestAnimationFrame(frame); })(last); }
    return { state: S, restart };
  }

  return { create, kiosk, models: Object.keys(MODELS), helpers: { clamp, rand, pick } };
})();
