// @ts-check
// three.js 2.5D renderer.
//
// It implements the SAME `makeRenderer(canvas) -> render(B)` contract the canvas
// renderer did, which is why sim.js and the headless balance harness needed no
// changes at all: the flat look lived entirely in the view layer.
//
// Camera (per design review): perspective, 32° vertical FOV, ~35° downward tilt,
// 10° yaw, aimed at midfield. That turns the field from a pair of parallel lines
// into a receding trapezoid, so lanes read as DEPTH instead of stacked rows —
// which was the actual cause of "units look piled on top of each other".
//
// Coordinate mapping (sim units are untouched):
//   worldX = simX            0..CFG.field.length along the field
//   worldZ = (lane - 2) * LANE_W     across the field, 0 = centre lane
//   worldY = up
//
// Units are camera-facing alpha-cutout planes rather than three.Sprite: sprites
// cannot receive a proper ground contact shadow and sort badly against each
// other, so each unit gets a plane plus a separate flat shadow disc.

import * as THREE from 'three';
import { SIDE } from '../engine/sim.js';
import { CFG } from '../config.js';
import { clipFor, samplePose, idlePose, clipDuration, GRIP, RELEASE_AT } from './rig.js';
import { buildRig, clipNameFor, clipInfo } from './cutout-rig.js';
import { buildSiegeRig, SIEGE_CLIP, siegeClipInfo } from './siege-rig.js';
import { buildCreatureRig, creatureClipInfo } from './creature-rig.js';
import { resolvePalette } from '../gen/palette.js';

const LANE_W = CFG.render.lanePitch;
const FIELD = () => CFG.field.length;

const COL = {
  demon: 0xff5a49, demonDeep: 0x7d1c17,
  human: 0x63bdf0, humanDeep: 0x16496e,
  gold: 0xe0b64f, ember: 0xff8a4a, arcane: 0xb08cf0, physical: 0xe4d6b4,
  ward: 0x8fe0c0, ok: 0x6bd39a,
};

const laneToZ = (lane) => (lane - (CFG.field.lanes - 1) / 2) * LANE_W;

export function makeRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x07060b, 1);
  renderer.shadowMap.enabled = false;          // fake discs instead: far cheaper

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b0913, 90, 260);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
  const tex = new THREE.TextureLoader();

  // Cut-out rig manifests. A unit with a manifest gets a real articulated
  // skeleton; anything without one keeps the single-sprite path, so art can be
  // upgraded unit by unit instead of all at once.
  // Callbacks always run asynchronously: unitView() registers one before it has
  // stored its own view object. The earlier version answered cached kinds
  // synchronously (so every unit after the first got no rig) and answered `null`
  // to units that asked while the first fetch was still in flight, which is why
  // only one tank in a "탱크 셋" cohort was drawn as a tank.
  const rigManifests = new Map();   // "human-artillery" -> Promise<manifest | null>
  function loadManifest(kind, cb) {
    if (!rigManifests.has(kind)) {
      rigManifests.set(kind, fetch(`./assets/unit-parts/${kind}/rig.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null));
    }
    rigManifests.get(kind).then(cb);
  }

  // ------------------------------------------------------------------ lights
  scene.add(new THREE.AmbientLight(0xb9b0d0, 0.85));
  const key = new THREE.DirectionalLight(0xfff0dd, 1.15);
  key.position.set(-30, 46, 26);
  scene.add(key);
  // faction rim lights, so each half of the field is lit by its own realm
  const demonLight = new THREE.PointLight(COL.demon, 90, 60, 2);
  demonLight.position.set(2, 9, 0);
  scene.add(demonLight);
  const humanLight = new THREE.PointLight(COL.human, 90, 60, 2);
  humanLight.position.set(FIELD() - 2, 9, 0);
  scene.add(humanLight);

  // ------------------------------------------------------------------ ground
  const groundW = FIELD() + 22;
  const groundD = CFG.field.lanes * LANE_W + 22;
  const groundGeo = new THREE.PlaneGeometry(groundW, groundD, 1, 1);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a2431, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(FIELD() / 2, 0, 0);
  scene.add(ground);
  loadTex('./assets/backdrops/ground.webp', (t) => {
    // ONE tile across the whole field: the texture carries the faction gradient
    // (plum left, teal right), so repeating it produced candy stripes.
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    groundMat.map = t;
    groundMat.color.setHex(0xffffff);
    groundMat.needsUpdate = true;
  });
  // A second, darker tiled layer under the field edges hides the clamp seams.
  const skirt = new THREE.Mesh(
    new THREE.PlaneGeometry(groundW + 200, groundD + 200),
    new THREE.MeshStandardMaterial({ color: 0x14111b, roughness: 1 }),
  );
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.set(FIELD() / 2, -0.05, 0);
  scene.add(skirt);

  // lane grooves: faint emissive strips so lanes stay readable in perspective
  for (let l = 0; l < CFG.field.lanes; l++) {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD() + 6, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05 }),
    );
    g.rotation.x = -Math.PI / 2;
    g.position.set(FIELD() / 2, 0.02, laneToZ(l));
    scene.add(g);
  }
  // midline
  const mid = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, groundD * 0.5),
    new THREE.MeshBasicMaterial({ color: COL.gold, transparent: true, opacity: 0.16 }),
  );
  mid.rotation.x = -Math.PI / 2;
  mid.position.set(FIELD() / 2, 0.03, 0);
  scene.add(mid);

  // ------------------------------------------------------------------ backdrop
  // sky as a huge back plane, ridge as a nearer cutout plane -> parallax comes
  // free from perspective rather than from hand-tuned scroll factors
  addBackPlane('./assets/backdrops/sky.webp', 700, 380, -280, 78, 1.0, false);
  addBackPlane('./assets/backdrops/ridge.webp', 400, 130, -130, 26, 1.0, true);

  function addBackPlane(url, w, h, z, y, opacity, transparent) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x2c2836, transparent, opacity, depthWrite: false, fog: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(FIELD() / 2, y, z);
    scene.add(m);
    loadTex(url, (t) => { mat.map = t; mat.color.setHex(0xffffff); mat.needsUpdate = true; });
  }

  // ------------------------------------------------------------------ structures
  /** @type {Map<any, {group:THREE.Group, mat:THREE.MeshBasicMaterial, glow:THREE.PointLight}>} */
  const structViews = new Map();

  function structView(st) {
    let v = structViews.get(st);
    if (v) return v;
    const isL = st.side === SIDE.L;
    const faction = isL ? 'demon' : 'human';
    const core = st.kind === 'core';
    const h = core ? 17 : 8.5;
    const group = new THREE.Group();

    const mat = new THREE.MeshBasicMaterial({
      color: isL ? COL.demonDeep : COL.humanDeep,
      transparent: true, alphaTest: 0.12, side: THREE.DoubleSide, fog: true,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(h, h), mat);
    plane.position.y = h / 2;
    if (!isL) plane.scale.x = -1;               // face inward
    group.add(plane);
    loadTex(`./assets/structures/${faction}-${st.kind}.webp`, (t) => {
      mat.map = t; mat.color.setHex(0xffffff); mat.needsUpdate = true;
    });

    // grounding disc so it doesn't look pasted on
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(h * 0.45, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.04;
    group.add(disc);

    const glow = new THREE.PointLight(isL ? COL.ember : COL.human, 60, 34, 2);
    glow.position.set(0, h * 0.4, 0);
    group.add(glow);

    group.position.set(st.x, 0, 0);
    scene.add(group);
    v = { group, mat, glow };
    structViews.set(st, v);
    return v;
  }

  // ------------------------------------------------------------------ units
  /** @type {Map<number, {group:THREE.Group, plane:THREE.Mesh, mat:THREE.MeshBasicMaterial, sigil:THREE.Mesh, shadow:THREE.Mesh, bar:THREE.Mesh, barMat:THREE.MeshBasicMaterial, ring:THREE.Mesh|null, seen:number}>} */
  const unitViews = new Map();
  let frameTag = 0;

  const SIGIL_GEO = {
    guard: new THREE.PlaneGeometry(1, 1),
    artillery: makeDiamond(0.62),
    raider: makeArrow(0.7),
  };

  function unitView(u) {
    let v = unitViews.get(u.id);
    if (v) return v;
    const isL = u.side === SIDE.L;
    const faction = isL ? 'demon' : 'human';
    const group = new THREE.Group();

    const mat = new THREE.MeshBasicMaterial({
      color: isL ? 0xff8f80 : 0x9fd6f5,
      transparent: true, alphaTest: 0.14, side: THREE.DoubleSide,
    });
    // BODY bone. One texture, so the character never drifts between frames.
    const body = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    body.add(plane);
    group.add(body);
    // Concept tint. 61 of the 88 appearance concepts share the biped part set, so
    // colour is what separates a skeleton from a knight until each has its own art.
    // The faction anchor is NOT touched — the sigil, ring and health bar stay
    // demon-red / human-blue so "which side is that" never depends on remembering
    // a concept palette.
    const pal = u.bp?.visual ? resolvePalette(u.bp.visual) : null;
    // Tint at HALF strength (lerp toward white). A full-strength concept palette
    // repainted the whole unit and started competing with the faction read — the
    // one thing the palette layer is not allowed to cost.
    const soften = (c) => {
      const r = (c >> 16) & 255, g = (c >> 8) & 255, b2 = c & 255;
      const m = (x) => Math.round(x + (255 - x) * 0.5);
      return (m(r) << 16) | (m(g) << 8) | m(b2);
    };
    const bodyTint = pal?.resolved ? soften(pal.body) : 0xffffff;
    const gearTint = pal?.resolved ? soften(pal.gear) : 0xffffff;
    loadTex(`./assets/units/${faction}-${u.role}.webp`, (t) => {
      mat.map = t; mat.color.setHex(bodyTint); mat.needsUpdate = true;
    });

    // WEAPON bone. Separate texture on its own pivot — this is what lets an
    // archer raise, draw and loose instead of just sliding forward.
    const wMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.14, side: THREE.DoubleSide, opacity: 0 });
    const weapon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), wMat);
    const wPivot = new THREE.Group();      // rotate here = rotate about the grip
    wPivot.add(weapon);
    body.add(wPivot);
    loadTex(`./assets/weapons/${faction}-${u.role}.webp`, (t) => {
      wMat.map = t; wMat.opacity = 1; wMat.needsUpdate = true;
    });

    // ground sigil = role, always visible under the art (combat grammar)
    const sigil = new THREE.Mesh(
      SIGIL_GEO[u.role] ?? SIGIL_GEO.guard,
      new THREE.MeshBasicMaterial({
        color: isL ? COL.demon : COL.human, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      }),
    );
    sigil.rotation.x = -Math.PI / 2;
    sigil.position.y = 0.05;
    group.add(sigil);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.03;
    group.add(shadow);

    const barMat = new THREE.MeshBasicMaterial({ color: COL.ok, transparent: true, opacity: 0.95, fog: false });
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.12), barMat);
    bar.visible = false;
    group.add(bar);

    let ring = null;
    if (u.splash > 0 || u.skills.includes('cleave')) {
      ring = new THREE.Mesh(
        new THREE.RingGeometry(0.86, 1.0, 24),
        new THREE.MeshBasicMaterial({ color: isL ? COL.demon : COL.human, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      group.add(ring);
    }

    // Try to upgrade this unit to a real bone rig. Until (or unless) the
    // manifest arrives, the single-sprite body above keeps playing.
    // Part set selection: an appearance concept with its own generated parts wins
    // over the generic role set. This is the whole point of the VisualIntent path —
    // "탱크" must load the landship, not the guard.
    const vis = u.bp?.visual;
    const kind = (vis?.rigReady && vis.concept && vis.rigFamily !== 'biped')
      ? `${faction}-${vis.concept}`
      : `${faction}-${u.role}`;
    const holder = new THREE.Group();
    body.add(holder);
    loadManifest(kind, (manifest) => {
      if (!manifest || !v) return;
      const texFor = (file, cb) => loadTex(`./assets/unit-parts/${kind}/${file}`, cb);
      const rig = manifest.rig === 'siege'
        ? buildSiegeRig(manifest, texFor, 1.25)     // a landship reads wider than tall
        : (manifest.rig === 'beast' || manifest.rig === 'flyer')
          ? buildCreatureRig(manifest, texFor, manifest.rig === 'flyer' ? 1.15 : 1.0)
          // a colossus uses the same 11-part biped sheet but must READ as a colossus
          : buildRig(manifest, texFor, vis?.rigFamily === 'giant' ? 1.45 : 1);
      if (!rig) return;
      // Parts that came from a concept-specific sheet are already the right colour;
      // only the SHARED biped set needs the tint.
      const shared = kind === `${faction}-${u.role}`;
      if (shared && pal?.resolved) {
        for (const [name, mesh] of Object.entries(rig.meshes)) {
          const isGear = /Fore|Upper|Shin|Thigh/.test(name);
          mesh.material.color.setHex(isGear ? gearTint : bodyTint);
        }
      }
      if (rig.family === 'siege' || rig.family === 'beast' || rig.family === 'flyer') {
        // a vehicle or a beast has no hands: skip the bow/arrow props entirely and
        // hide the single-sprite body the rig replaces
        v.rig = rig;
        v.isBow = false;
        holder.add(rig.root);
        v.plane.visible = false;
        if (v.weapon) v.weapon.visible = false;
        return;
      }
      // hand-held props live on the hand joints
      const bowMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.12, side: THREE.DoubleSide, depthWrite: false });
      const bow = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52), bowMat);
      bow.renderOrder = 18;
      // Weapon art exists per ROLE, not per appearance concept — a colossus loads the
      // biped rig from its own part folder but has no `weapons/demon-colossus.webp`,
      // which showed up as a 404 in the clip capture.
      loadTex(`./assets/weapons/${faction}-${u.role}.webp`, (t) => { bowMat.map = t; bowMat.needsUpdate = true; });
      const bowHand = new THREE.Group();
      bowHand.position.set(0, -0.26, 0.01);
      bowHand.add(bow);
      rig.joints.frontFore?.add(bowHand);

      // bowstring: three points, the middle one riding the draw hand
      const strGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.22, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.22, 0)]);
      const string = new THREE.Line(strGeo, new THREE.LineBasicMaterial({ color: 0xe8e0cf, transparent: true, opacity: 0.9 }));
      string.renderOrder = 19;
      bowHand.add(string);

      const arrowMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.12, side: THREE.DoubleSide, depthWrite: false });
      const heldArrow = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), arrowMat);
      heldArrow.renderOrder = 20;
      loadTex('./assets/weapons/ammo-physical.webp', (t) => { arrowMat.map = t; arrowMat.needsUpdate = true; });
      const drawHand = new THREE.Group();
      drawHand.position.set(0, -0.26, 0.02);
      drawHand.add(heldArrow);
      rig.joints.backFore?.add(drawHand);

      v.rig = rig;
      v.bowHand = bowHand;
      v.drawHand = drawHand;
      v.string = string;
      v.heldArrow = heldArrow;
      v.isBow = u.role === 'artillery' && u.channel !== 'arcane';
      bow.visible = u.role === 'artillery';
      heldArrow.visible = false;
      string.visible = false;
      holder.add(rig.root);
      plane.visible = false;        // the rig replaces the flat sprite
      v.wPivot.visible = false;
    });

    scene.add(group);
    v = { group, body, plane, mat, weapon, wPivot, wMat, sigil, shadow, bar, barMat, ring, holder, rig: null, seen: frameTag };
    unitViews.set(u.id, v);
    return v;
  }

  // ------------------------------------------------------------------ fx pools
  const shotPool = [];
  const hitPool = [];

  function takeShot() {
    const s = shotPool.find((m) => !m.visible);
    if (s) { s.visible = true; return s; }
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 8, 8),
      new THREE.MeshBasicMaterial({ color: COL.physical, fog: false }),
    );
    scene.add(m);
    shotPool.push(m);
    return m;
  }
  function takeHit() {
    const s = hitPool.find((m) => !m.visible);
    if (s) { s.visible = true; return s; }
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.5, 14),
      new THREE.MeshBasicMaterial({ color: 0xfff0c4, transparent: true, side: THREE.DoubleSide, fog: false }),
    );
    scene.add(m);
    hitPool.push(m);
    return m;
  }

  // ------------------------------------------------------------------ camera
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  /** Frame the whole field, tilted and slightly yawed, and drift toward the front. */
  function placeCamera(B, front) {
    const aspect = Math.max(0.6, camera.aspect);
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    // Fit the field PLUS both cores and a margin. The tilt foreshortens the
    // ground, so the horizontal budget has to be generous or the cores fall off
    // the sides — which is exactly what the first pass did.
    const wantWidth = FIELD() + CFG.render.camera.margin;
    const need = (wantWidth / 2) / (Math.tan(halfFov) * aspect);
    const tilt = THREE.MathUtils.degToRad(34);
    const yaw = THREE.MathUtils.degToRad(8);

    // camera drifts a little toward whoever is winning: the world reports state
    const focusX = FIELD() / 2 + (front - FIELD() / 2) * CFG.render.camera.drift;
    const dist = Math.max(need, CFG.render.camera.minDist);
    camera.position.set(
      focusX - Math.sin(yaw) * dist * 0.35,
      Math.sin(tilt) * dist,
      Math.cos(tilt) * dist,
    );
    camera.lookAt(focusX, 4.5, -2);
  }

  // ------------------------------------------------------------------ helpers
  function loadTex(url, cb) {
    tex.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      cb(t);
    }, undefined, () => { /* asset missing: keep the flat colour */ });
  }

  function makeDiamond(r) {
    const s = new THREE.Shape();
    s.moveTo(0, r); s.lineTo(r, 0); s.lineTo(0, -r); s.lineTo(-r, 0); s.closePath();
    return new THREE.ShapeGeometry(s);
  }
  function makeArrow(r) {
    const s = new THREE.Shape();
    s.moveTo(r, 0); s.lineTo(-r * 0.6, r * 0.7); s.lineTo(-r * 0.25, 0); s.lineTo(-r * 0.6, -r * 0.7); s.closePath();
    return new THREE.ShapeGeometry(s);
  }

  function frontOf(B) {
    const ls = B.units.filter((u) => u.side === SIDE.L && u.hp > 0);
    const rs = B.units.filter((u) => u.side === SIDE.R && u.hp > 0);
    if (!ls.length && !rs.length) return FIELD() / 2;
    const lMax = ls.length ? Math.max(...ls.map((u) => u.x)) : 0;
    const rMin = rs.length ? Math.min(...rs.map((u) => u.x)) : FIELD();
    return (lMax + rMin) / 2;
  }

  // ------------------------------------------------------------------ render
  return function render(B) {
    if (canvas.clientWidth !== renderer.domElement.width / renderer.getPixelRatio()) resize();
    frameTag++;

    placeCamera(B, frontOf(B));

    // ---- structures
    for (const st of B.structures) {
      const v = structView(st);
      const ratio = Math.max(0, st.hp / st.maxHp);
      v.group.visible = st.hp > 0;
      v.glow.intensity = 24 + 46 * ratio;
      // dim as it dies; the field itself shows who is losing
      v.mat.color.setScalar(0.55 + 0.45 * ratio);
    }

    // ---- units
    for (const u of B.units) {
      if (u.hp <= 0) continue;
      const v = unitView(u);
      v.seen = frameTag;

      // world scale from HP so a fat unit reads as fat, clamped for legibility
      const size = THREE.MathUtils.clamp(3.4 + Math.sqrt(u.maxHp) * 0.085, 3.8, 7.6);

      // --- SKELETAL RIG. Body and weapon are separate bones, so an attack is a
      // real articulated motion (wind-up, strike, recover) instead of a slide.
      const walking = !u.engaged;
      const clip = clipFor(u);
      const dur = clipDuration(u.cadence);
      const atkAge = u.lastAttackAt != null ? B.t - u.lastAttackAt : 99;
      const attacking = atkAge < dur;

      const idle = idlePose(B.t, u.id * 0.7, walking);
      let pose = { weaponRot: idle.weaponRot, weaponReach: 0, torsoRot: 0, torsoPush: 0 };
      if (attacking) {
        const sampled = samplePose(clip, atkAge / dur);
        // blend out of idle so the transition doesn't pop
        const w = Math.min(1, (atkAge / dur) * 6);
        pose = {
          weaponRot: idle.weaponRot * (1 - w) + sampled.weaponRot * w,
          weaponReach: sampled.weaponReach * w,
          torsoRot: sampled.torsoRot * w,
          torsoPush: sampled.torsoPush * w,
        };
      }

      const hurtAge = u.lastHurtAt != null ? B.t - u.lastHurtAt : 99;
      const HURT = 0.18;
      let knock = 0, flash = 0;
      if (hurtAge < HURT) {
        const p3 = 1 - hurtAge / HURT;
        knock = -p3 * size * 0.1 * u.dir;
        flash = p3;
      }

      const face = u.side === SIDE.L ? 1 : -1;
      const dirSign = (u.attackDir ?? u.dir) >= 0 ? 1 : -1;

      v.group.position.set(u.x + pose.torsoPush * size * dirSign + knock, 0, laneToZ(u.lane));

      // body bone: camera-facing plane, leaning into the swing
      v.body.quaternion.copy(camera.quaternion);
      v.body.rotateZ(-face * (idle.bodyLean + pose.torsoRot));
      v.body.position.y = size / 2 + Math.abs(idle.bodyBob) * size;
      v.plane.scale.set(face * size, size, 1);

      // weapon bone: hangs at the grip, rotates about it, extends on the strike
      const grip = GRIP[u.role] ?? GRIP.guard;
      v.wPivot.position.set(face * grip.x * size, (grip.y - 0.5) * size, u.role === 'guard' ? -0.05 : 0.06);
      v.wPivot.rotation.z = -face * pose.weaponRot;
      const reach = pose.weaponReach * size;
      v.weapon.position.set(reach, 0, 0);
      v.weapon.scale.set(face * grip.scale * size, grip.scale * size, 1);

      if (v.mat.map) v.mat.color.setScalar(1 + flash * 1.4);

      // ---- articulated rig (when this unit has parts)
      if (v.rig) {
        const rigClip = clipNameFor(u);
        // a siege clip has its own release point (breech flash), so the timing that
        // drives "shot leaves the barrel" must come from that clip, not the bow's
        const info = v.rig.family === 'siege' ? siegeClipInfo()
          : (v.rig.family === 'beast' || v.rig.family === 'flyer') ? creatureClipInfo(v.rig.family)
          : clipInfo(rigClip);
        // The bow has to START DRAWING BEFORE the shot resolves, or the arrow
        // leaves an undrawn bow. So the clip is driven off the attack cooldown:
        // it runs up to the release point as the cooldown expires, then plays out.
        let ct, blend;
        if (attacking) {
          ct = info.release + (1 - info.release) * Math.min(1, atkAge / (info.duration * (1 - info.release)));
          blend = 1;
        } else if (u.engaged && u.cd > 0) {
          const wind = Math.max(0.001, info.duration * info.release);
          const left = Math.min(u.cd, wind);
          ct = info.release * (1 - left / wind);
          blend = Math.min(1, (wind - left) / (wind * 0.5) + 0.35);
        } else {
          ct = 0; blend = 0;
        }
        // Part sheets are drawn facing screen-right, like the flat sprites, so the
        // right-hand side has to be mirrored too or its units walk backwards.
        v.rig.root.scale.set(face * size * 0.92, size * 0.92, size * 0.92);
        v.rig.pose(v.rig.family === 'biped' || !v.rig.family ? rigClip : SIEGE_CLIP,
                   ct, B.t, u.id * 0.7, walking, blend);

        if (v.isBow) {
          const drawing = blend > 0.05 && ct < info.release;
          v.heldArrow.visible = drawing;
          v.string.visible = true;
          // bend the string toward the draw hand: convert the hand's world
          // position into the bow's local space so the notch always tracks it
          const hp = new THREE.Vector3();
          v.drawHand.getWorldPosition(hp);
          v.bowHand.worldToLocal(hp);
          const pos = v.string.geometry.attributes.position;
          pos.setXYZ(1, THREE.MathUtils.clamp(hp.x, -0.9, 0.05), hp.y * 0.35, 0.01);
          pos.needsUpdate = true;
        }
      }

      // Ground marks must stay SMALLER than the body they belong to. At 0.62 the
      // role sigil was a 2.4-4.7m diamond under a character whose visible width is
      // roughly a third of that, so the screen read as "big diamonds with tiny
      // people standing on them".
      v.sigil.scale.setScalar(size * 0.40);
      v.sigil.rotation.z = u.side === SIDE.L ? 0 : Math.PI;
      v.shadow.scale.setScalar(size * 0.30);
      if (v.ring) v.ring.scale.setScalar(size * 0.55);   // splash ring is a RANGE, keep it truthful

      const ratio = Math.max(0, u.hp / u.maxHp);
      v.bar.visible = ratio < 1;
      if (v.bar.visible) {
        v.bar.quaternion.copy(camera.quaternion);
        v.bar.position.y = size * 1.08;
        v.bar.scale.set(size * 0.8 * ratio, 1, 1);
        v.barMat.color.setHex(ratio > 0.45 ? COL.ok : COL.gold);
      }
      v.mat.opacity = u.veil > 0 ? 0.35 : 1;
      v.mat.transparent = true;
    }

    // retire views for dead units
    let rigged = 0;
    for (const [id, v] of unitViews) {
      if (v.seen === frameTag) { if (v.rig) rigged++; continue; }
      scene.remove(v.group);
      v.mat.dispose();
      unitViews.delete(id);
    }
    // How many live units are drawn with their rig; read by tools/smoke.mjs.
    if (canvas.dataset.units !== String(unitViews.size)) canvas.dataset.units = String(unitViews.size);
    if (canvas.dataset.rigged !== String(rigged)) canvas.dataset.rigged = String(rigged);

    // ---- fx
    for (const m of shotPool) m.visible = false;
    for (const m of hitPool) m.visible = false;
    for (const f of B.fx) {
      const age = (B.t - f.t) / (f.dur ?? 0.6);
      if (age > 1 || age < 0) continue;
      if (f.type === 'shot') {
        const m = takeShot();
        const x0 = f.x, z0 = laneToZ(f.lane), x1 = f.tx, z1 = laneToZ(f.tlane);
        const lift = f.arc ? Math.sin(age * Math.PI) * Math.abs(x1 - x0) * 0.22 : 0;
        m.position.set(x0 + (x1 - x0) * age, 1.6 + lift, z0 + (z1 - z0) * age);
        m.material.color.setHex(f.channel === 'arcane' ? COL.arcane : COL.physical);
        m.scale.setScalar(f.channel === 'arcane' ? 1.25 : 0.85);
      } else if (f.type === 'hit' || f.type === 'corehit') {
        const m = takeHit();
        const big = f.type === 'corehit';
        m.position.set(f.x, big ? 3 : 1.5, laneToZ(f.lane ?? 0));
        m.quaternion.copy(camera.quaternion);
        // a hit spark bigger than the unit it hits reads as an explosion
        m.scale.setScalar((big ? 2.6 : 0.85) * (0.6 + age * 1.5));
        m.material.opacity = 1 - age;
        m.material.color.setHex(big ? COL.gold : 0xfff0c4);
      }
    }

    renderer.render(scene, camera);
  };
}
