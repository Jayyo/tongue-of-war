// @ts-check
// QUADRUPED and WINGED rigs. Same interface as buildRig()/buildSiegeRig():
//   { root, joints, meshes, family, pose(name, t, time, seed, walking, blend) }
//
// A wolf driven by the biped rig would need shoulders it does not have, and a
// dragon needs a wing that beats — so each family gets its own bone chain and its
// own idle. The gait is a phase-offset leg swing; the flyer's idle IS the flap,
// because a landed dragon reads as a statue.

import * as THREE from 'three';

const PROPORTION = {
  beast: { body: 0.52, head: 0.34, frontLeg: 0.40, hindLeg: 0.44, tail: 0.26 },
  flyer: { body: 0.46, head: 0.30, wing: 0.62, hindLeg: 0.34, tail: 0.40 },
};
const Z = {
  beast: { tail: 0.00, hindLeg: 0.005, body: 0.02, frontLeg: 0.03, head: 0.025 },
  flyer: { wing: 0.00, tail: 0.005, hindLeg: 0.01, body: 0.02, head: 0.025 },
};

const CLIPS = {
  beast: {
    duration: 0.7, release: 0.42,
    // lunge: coil, snap forward, recover
    body:  [[0, 0], [0.3, -0.06], [0.44, 0.14], [0.7, 0.03], [1, 0]],
    head:  [[0, 0], [0.3, 0.10], [0.44, -0.28], [0.7, -0.05], [1, 0]],
    front: [[0, 0], [0.3, -0.25], [0.46, 0.55], [0.8, 0], [1, 0]],
  },
  flyer: {
    duration: 0.85, release: 0.46,
    body:  [[0, 0], [0.34, -0.05], [0.48, 0.12], [0.75, 0.02], [1, 0]],
    head:  [[0, 0], [0.34, 0.12], [0.48, -0.30], [0.75, -0.04], [1, 0]],
    wing:  [[0, 0], [0.3, -0.45], [0.5, 0.35], [0.8, -0.1], [1, 0]],
  },
};

function sample(track, t) {
  if (!track?.length) return 0;
  if (t <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i++) {
    const [t1, v1] = track[i];
    if (t <= t1) {
      const [t0, v0] = track[i - 1];
      const k = (t - t0) / Math.max(1e-6, t1 - t0);
      return v0 + (v1 - v0) * (k * k * (3 - 2 * k));
    }
  }
  return track[track.length - 1][1];
}

export const creatureClipInfo = (fam) => CLIPS[fam] ?? CLIPS.beast;

/**
 * @param {{rig:string, parts:Record<string,{w:number,h:number}>, pivots?:any, mounts?:any}} manifest
 * @param {(file:string, cb:(t:THREE.Texture)=>void)=>void} texFor
 * @param {number} unitHeight
 */
export function buildCreatureRig(manifest, texFor, unitHeight) {
  const fam = manifest?.rig === 'flyer' ? 'flyer' : 'beast';
  const P = manifest?.parts;
  if (!P?.body) return null;

  const root = new THREE.Group();
  /** @type {Record<string, THREE.Group>} */
  const joints = {};
  /** @type {Record<string, THREE.Mesh>} */
  const meshes = {};
  const prop = PROPORTION[fam];

  const sizeOf = (name) => {
    const p = P[name];
    if (!p) return null;
    const h = unitHeight * (prop[name] ?? 0.3);
    return { w: h * (p.w / Math.max(1, p.h)), h };
  };

  /** @param {string} name @param {string} key texture/part key @param {THREE.Group|null} parent */
  const mk = (name, key, parent, flipZ = 0) => {
    const s = sizeOf(key);
    if (!s) return null;
    const joint = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    const [px, py] = manifest.pivots?.[key] ?? [0.5, 0.5];
    mesh.position.set((0.5 - px) * s.w, (py - 0.5) * s.h, (Z[fam][key] ?? 0) + flipZ);
    mesh.renderOrder = 10 + Math.round(((Z[fam][key] ?? 0) + flipZ) * 100);
    texFor(`${key}.webp`, (t) => { mat.map = t; mat.needsUpdate = true; });
    joint.add(mesh);
    (parent ?? root).add(joint);
    joints[name] = joint;
    meshes[name] = mesh;
    return s;
  };

  const body = mk('body', 'body', null);
  const mount = (name, key, parent, dflt, flipZ = 0) => {
    const s = mk(name, key, parent, flipZ);
    if (!s || !body) return;
    const [mx, my] = manifest.mounts?.[key] ?? dflt;
    joints[name].position.set((mx - 0.5) * body.w, (0.5 - my) * body.h, 0);
  };

  mount('tail', 'tail', joints.body, [0.06, 0.35]);
  mount('head', 'head', joints.body, [0.86, 0.30]);
  if (fam === 'beast') {
    // two visible legs per pair, offset in depth so the far one reads as behind
    mount('frontLegFar', 'frontLeg', joints.body, [0.70, 0.80], -0.02);
    mount('frontLeg', 'frontLeg', joints.body, [0.70, 0.80], 0.02);
    mount('hindLegFar', 'hindLeg', joints.body, [0.24, 0.80], -0.02);
    mount('hindLeg', 'hindLeg', joints.body, [0.24, 0.80], 0.02);
  } else {
    mount('wingFar', 'wing', joints.body, [0.45, 0.28], -0.03);
    mount('hindLeg', 'hindLeg', joints.body, [0.42, 0.82], 0.01);
    mount('wing', 'wing', joints.body, [0.45, 0.28], 0.03);
  }

  // stand the creature on the ground
  const legH = sizeOf(fam === 'beast' ? 'hindLeg' : 'hindLeg')?.h ?? 0;
  if (joints.body) joints.body.position.y = legH * 0.86 + (body?.h ?? 0) * 0.5;
  const bodyY0 = joints.body ? joints.body.position.y : 0;

  return {
    root, joints, meshes, height: unitHeight, family: fam,
    pose(_name, t, time, seed, walking, blend) {
      const clip = CLIPS[fam];
      const gait = walking ? Math.sin(time * (fam === 'flyer' ? 4.2 : 7.4) + seed) : 0;
      const bob = walking ? Math.abs(gait) * unitHeight * 0.03 : Math.sin(time * 1.6 + seed) * unitHeight * 0.008;
      if (joints.body) {
        joints.body.position.y = bodyY0 + bob + sample(clip.body, t) * unitHeight * blend;
        joints.body.rotation.z = gait * 0.03 + sample(clip.body, t) * 0.30 * blend;
      }
      if (joints.head) joints.head.rotation.z = gait * 0.06 + sample(clip.head, t) * blend;
      if (joints.tail) joints.tail.rotation.z = -gait * 0.22 + Math.sin(time * 3.1 + seed) * 0.06;
      if (fam === 'beast') {
        const swing = gait * 0.5;
        if (joints.frontLeg) joints.frontLeg.rotation.z = swing + sample(clip.front, t) * blend;
        if (joints.frontLegFar) joints.frontLegFar.rotation.z = -swing * 0.8 + sample(clip.front, t) * 0.6 * blend;
        if (joints.hindLeg) joints.hindLeg.rotation.z = -swing;
        if (joints.hindLegFar) joints.hindLegFar.rotation.z = swing * 0.8;
      } else {
        // wings beat continuously; the attack clip adds a hard downbeat
        const flap = Math.sin(time * 6.2 + seed) * 0.42;
        if (joints.wing) joints.wing.rotation.z = flap + sample(clip.wing, t) * blend;
        if (joints.wingFar) joints.wingFar.rotation.z = flap * 0.85 + sample(clip.wing, t) * 0.8 * blend;
        if (joints.hindLeg) joints.hindLeg.rotation.z = -0.18 + flap * 0.1;
      }
    },
  };
}
