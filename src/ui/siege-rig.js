// @ts-check
// SIEGE rig: hull + track + turret + barrel + front plate.
//
// Same interface as cutout-rig.js's buildRig() so the renderer can swap families
// without special-casing: { root, joints, meshes, pose(name, t, time, seed, walking, blend) }.
//
// Why a separate rig instead of reusing the biped: a landship has no elbows. The
// motion that sells it is a recoiling barrel, a rolling track, and a hull that
// pitches when it fires or rolls over the ground — driving that through arm bones
// would look like a man waving a plank, which is exactly the failure the visual
// lexicon exists to prevent.

import * as THREE from 'three';

/** Part heights as a fraction of the whole vehicle height (art-independent). */
const PROPORTION = { hull: 0.52, track: 0.30, turret: 0.26, barrel: 0.14, plate: 0.34 };

/** Draw order back-to-front: track behind hull, turret and barrel on top. */
const Z = { track: 0.00, plate: 0.01, hull: 0.02, turret: 0.03, barrel: 0.035 };

const CLIPS = {
  // t is 0..1 across one attack cadence. `release` is when the shot leaves.
  cannon: {
    release: 0.34,
    duration: 0.9,          // seconds; the renderer scales this by the unit's cadence
    // barrel: settle -> snap back on release -> ease forward
    barrel: [[0, 0], [0.3, -0.02], [0.34, 0.20], [0.55, 0.06], [1, 0]],
    hull:   [[0, 0], [0.3, 0], [0.36, 0.055], [0.6, 0.015], [1, 0]],
    recoil: [[0, 0], [0.33, 0], [0.36, -0.10], [0.7, -0.02], [1, 0]],
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
      return v0 + (v1 - v0) * (k * k * (3 - 2 * k));       // smoothstep
    }
  }
  return track[track.length - 1][1];
}

export const SIEGE_CLIP = 'cannon';
export const siegeClipInfo = () => CLIPS.cannon;

/**
 * @param {{parts:Record<string,{w:number,h:number}>, pivots?:any, mounts?:any}} manifest
 * @param {(file:string, cb:(t:THREE.Texture)=>void)=>void} texFor
 * @param {number} unitHeight world height of the whole vehicle
 */
export function buildSiegeRig(manifest, texFor, unitHeight) {
  const P = manifest?.parts;
  if (!P?.hull || !P?.track) return null;

  const root = new THREE.Group();
  /** @type {Record<string, THREE.Group>} */
  const joints = {};
  /** @type {Record<string, THREE.Mesh>} */
  const meshes = {};

  const sizeOf = (name) => {
    const p = P[name];
    if (!p) return null;
    const h = unitHeight * (PROPORTION[name] ?? 0.3);
    return { w: h * (p.w / Math.max(1, p.h)), h };
  };

  const mk = (name, parent) => {
    const s = sizeOf(name);
    if (!s) return null;
    const joint = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    // offset the plane so the joint sits on the declared pivot instead of the centre
    const [px, py] = manifest.pivots?.[name] ?? [0.5, 0.5];
    mesh.position.set((0.5 - px) * s.w, (py - 0.5) * s.h, Z[name] ?? 0);
    mesh.renderOrder = 10 + Math.round((Z[name] ?? 0) * 100);
    texFor(`${name}.webp`, (t) => { mat.map = t; mat.needsUpdate = true; });
    joint.add(mesh);
    (parent ?? root).add(joint);
    joints[name] = joint;
    meshes[name] = mesh;
    return s;
  };

  const track = mk('track', null);
  const hull = mk('hull', null);
  mk('plate', joints.hull);
  const turret = mk('turret', joints.hull);
  mk('barrel', joints.turret ?? joints.hull);

  // Stack: track on the ground, hull on the track, turret on the hull deck.
  if (joints.track) joints.track.position.set(0, (track?.h ?? 0) * 0.5, 0);
  if (joints.hull) joints.hull.position.set(0, (track?.h ?? 0) * 0.92, 0);
  if (joints.turret && hull) {
    const [mx, my] = manifest.mounts?.turret ?? [0.42, 0.16];
    joints.turret.position.set((mx - 0.5) * hull.w, (0.5 - my) * hull.h, 0);
  }
  if (joints.barrel && turret) {
    const [mx, my] = manifest.mounts?.barrel ?? [0.78, 0.45];
    joints.barrel.position.set((mx - 0.5) * turret.w, (0.5 - my) * turret.h, 0);
  }
  if (joints.plate && hull) {
    const [mx, my] = manifest.mounts?.plate ?? [0.02, 0.70];
    joints.plate.position.set((mx - 0.5) * hull.w, (0.5 - my) * hull.h, 0);
  }

  const hullY0 = joints.hull ? joints.hull.position.y : 0;
  const barrelX0 = joints.barrel ? joints.barrel.position.x : 0;

  return {
    root, joints, meshes, height: unitHeight, family: 'siege',
    pose(_name, t, time, seed, walking, blend) {
      const clip = CLIPS.cannon;
      // rolling: the hull bobs and the whole vehicle pitches slightly while moving
      const roll = walking ? Math.sin(time * 6.5 + seed) * 0.012 : 0;
      const bob = walking ? Math.abs(Math.sin(time * 6.5 + seed)) * unitHeight * 0.012 : 0;
      if (joints.hull) {
        joints.hull.position.y = hullY0 + bob + sample(clip.hull, t) * unitHeight * blend;
        joints.hull.rotation.z = roll + sample(clip.hull, t) * 0.35 * blend;
      }
      if (joints.barrel) {
        joints.barrel.rotation.z = sample(clip.barrel, t) * blend;
        // breech recoil slides the barrel back along its own axis
        joints.barrel.position.x = barrelX0 + sample(clip.recoil, t) * unitHeight * blend;
      }
      if (joints.turret) joints.turret.rotation.z = sample(clip.hull, t) * -0.12 * blend;
      // track texture scroll would need a repeating map; the visible motion here is
      // the hull bob, which is enough at this camera distance.
    },
  };
}
