// @ts-check
// Cut-out bone rig: a real articulated skeleton built from sliced body parts.
//
// Hierarchy (parents come from rig.json):
//
//   pelvis
//    ├ torso ─ head
//    │   ├ frontUpper ─ frontFore ─ (bowHand) ─ bow ─ bowString
//    │   └ backUpper  ─ backFore  ─ (drawHand) ─ heldArrow
//    ├ frontThigh ─ frontShin
//    └ backThigh  ─ backShin
//
// Each part is a textured plane whose geometry is OFFSET so the mesh rotates
// about its joint, not its centre. That offset is the entire difference between
// "a limb that bends" and "a limb that detaches".
//
// The archery clip drives shoulder AND elbow independently, brings the draw hand
// to the cheek, bends the bowstring to follow that hand, and releases on the
// exact frame the projectile leaves — the five things a bow has to do to look
// like a bow.

import * as THREE from 'three';

/** Bone angle tracks. Values are radians, keyed on 0..1 clip time. */
const CLIPS = {
  bow: {
    duration: 1.05,
    release: 0.62,
    tracks: {
      // shoulder of the bow arm: raise to horizontal and hold
      frontUpper: [[0, 0.55], [0.20, -0.05], [0.60, -0.08], [0.75, 0.10], [1, 0.55]],
      // bow arm stays fairly straight once raised
      frontFore:  [[0, 0.35], [0.20, 0.06], [0.60, 0.04], [0.78, 0.16], [1, 0.35]],
      // draw shoulder pulls back and up
      backUpper:  [[0, 0.50], [0.22, 0.10], [0.50, -0.30], [0.60, -0.34], [0.66, 0.30], [1, 0.50]],
      // ELBOW: this is what actually pulls the string to the cheek
      backFore:   [[0, 0.30], [0.22, 0.55], [0.50, 1.75], [0.60, 1.85], [0.66, 0.20], [1, 0.30]],
      torso:      [[0, 0], [0.45, -0.06], [0.60, -0.07], [0.68, 0.05], [1, 0]],
      head:       [[0, 0], [0.45, -0.05], [0.62, -0.05], [1, 0]],
    },
  },
  melee: {
    duration: 0.62, release: 0.44,
    tracks: {
      frontUpper: [[0, 0.35], [0.22, -0.85], [0.44, 1.05], [0.62, 0.55], [1, 0.35]],
      frontFore:  [[0, 0.30], [0.22, 0.95], [0.44, -0.15], [0.62, 0.20], [1, 0.30]],
      backUpper:  [[0, 0.40], [0.30, 0.60], [0.50, 0.20], [1, 0.40]],
      backFore:   [[0, 0.30], [1, 0.30]],
      torso:      [[0, 0], [0.22, -0.14], [0.44, 0.18], [0.62, 0.06], [1, 0]],
      head:       [[0, 0], [0.44, 0.08], [1, 0]],
    },
  },
  thrust: {
    duration: 0.5, release: 0.4,
    tracks: {
      frontUpper: [[0, 0.30], [0.20, -0.30], [0.40, 0.15], [0.60, 0.05], [1, 0.30]],
      frontFore:  [[0, 0.55], [0.20, 1.05], [0.40, -0.05], [0.60, 0.25], [1, 0.55]],
      backUpper:  [[0, 0.45], [1, 0.45]],
      backFore:   [[0, 0.35], [1, 0.35]],
      torso:      [[0, 0], [0.20, -0.10], [0.40, 0.14], [1, 0]],
      head:       [[0, 0], [1, 0]],
    },
  },
  cast: {
    duration: 0.9, release: 0.5,
    tracks: {
      frontUpper: [[0, 0.20], [0.30, -0.55], [0.50, -0.45], [0.72, -0.10], [1, 0.20]],
      frontFore:  [[0, 0.30], [0.30, 0.10], [0.50, 0.05], [1, 0.30]],
      backUpper:  [[0, 0.35], [0.30, -0.25], [0.50, -0.20], [1, 0.35]],
      backFore:   [[0, 0.40], [0.30, 0.30], [1, 0.40]],
      torso:      [[0, 0], [0.30, -0.09], [0.52, 0.12], [1, 0]],
      head:       [[0, 0], [0.30, -0.06], [1, 0]],
    },
  },
};

/** Gentle idle/walk motion layered under every clip. */
function idleTracks(t, seed, walking) {
  const f = walking ? 6.6 : 2.0;
  const amp = walking ? 1 : 0.3;
  const p = t * f + seed;
  return {
    pelvisY: Math.abs(Math.sin(p)) * 0.02 * amp,
    torso: Math.sin(p) * 0.03 * amp,
    head: Math.sin(p + 0.4) * 0.04 * amp,
    frontThigh: walking ? Math.sin(p) * 0.42 : 0.05,
    frontShin: walking ? Math.max(0, -Math.sin(p)) * 0.5 : 0.05,
    backThigh: walking ? Math.sin(p + Math.PI) * 0.42 : -0.05,
    backShin: walking ? Math.max(0, -Math.sin(p + Math.PI)) * 0.5 : 0.05,
    frontUpper: Math.sin(p) * 0.12 * amp,
    backUpper: Math.sin(p + Math.PI) * 0.12 * amp,
    frontFore: 0, backFore: 0,
  };
}

function sample(track, t) {
  if (!track || !track.length) return 0;
  if (t <= track[0][0]) return track[0][1];
  for (let i = 0; i < track.length - 1; i++) {
    const [t0, v0] = track[i], [t1, v1] = track[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / Math.max(1e-4, t1 - t0);
      const s = k * k * (3 - 2 * k);          // smoothstep
      return v0 + (v1 - v0) * s;
    }
  }
  return track[track.length - 1][1];
}

export function clipNameFor(u) {
  if (u.role === 'artillery') return u.channel === 'arcane' ? 'cast' : 'bow';
  if (u.role === 'raider') return 'thrust';
  return 'melee';
}
export const clipInfo = (name) => CLIPS[name] ?? CLIPS.melee;

/**
 * Build a rig instance from a manifest. Returns null if the manifest is missing,
 * so callers can fall back to the single-sprite path.
 */
// Anatomy, as multiples of TORSO length. The generator draws each part filling
// its own grid cell, so raw pixel sizes are NOT proportional — a forearm can come
// out taller than a torso. Rescaling every part to these ratios is what turns a
// pile of correct-looking pieces into a correct-looking body.
const PROPORTION = {
  pelvis: 0.34, torso: 1.00, head: 0.62,
  frontUpper: 0.46, backUpper: 0.46,
  frontFore: 0.48, backFore: 0.48,
  frontThigh: 0.52, backThigh: 0.52,
  frontShin: 0.54, backShin: 0.54,
};

export function buildRig(manifest, texFor, unitPxHeight) {
  if (!manifest?.parts?.pelvis) return null;

  /** @type {Record<string, THREE.Group>} */
  const joints = {};
  /** @type {Record<string, THREE.Mesh>} */
  const meshes = {};
  const root = new THREE.Group();

  // Scale: the assembled figure should be about `unitPxHeight` tall in world
  // units. Total height is estimated from the leg + torso + head chain.
  const P = manifest.parts;
  // Standing height in TORSO units, from the proportion table above.
  const stackTorsos = PROPORTION.backShin + PROPORTION.backThigh
    + PROPORTION.pelvis * 0.6 + PROPORTION.torso + PROPORTION.head * 0.7;
  const torsoLen = unitPxHeight / stackTorsos;   // world length of one torso
  /** Rendered size of a part, normalised to anatomy rather than to its texture. */
  const sizeOf = (name) => {
    const p = P[name];
    const h = torsoLen * (PROPORTION[name] ?? 0.5);
    return { w: h * (p.w / Math.max(1, p.h)), h };
  };
  const S = torsoLen / Math.max(1, P.torso?.h ?? 1);   // kept for callers

  const order = ['pelvis', 'torso', 'head', 'frontThigh', 'frontShin', 'backThigh', 'backShin',
    'frontUpper', 'frontFore', 'backUpper', 'backFore'];

  for (const name of order) {
    const p = P[name];
    if (!p) continue;
    const joint = new THREE.Group();
    joints[name] = joint;

    const { w, h } = sizeOf(name);
    // Offset the geometry so the PIVOT lands on the joint origin.
    // pivot is (x, y) as fractions from the part's top-left; +y is DOWN in the
    // image but UP in world, hence the sign flip on the vertical term.
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate((0.5 - p.pivot[0]) * w, (0.5 - p.pivot[1]) * -h, 0);

    const mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.12, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10 + (p.z ?? 0);
    joint.add(mesh);
    meshes[name] = mesh;
    texFor(p.file, (t) => { mat.map = t; mat.needsUpdate = true; });
  }

  // parent the joints, and place each child at its attachment point on the parent
  // Offsets are fractions of the PARENT part's full height, measured from the
  // parent's pivot. Each child sits where that joint physically is on the parent.
  const ATTACH = {
    torso:      { x: 0.00, y: 0.30 },   // pelvis pivot is mid-hip; torso sits above
    head:       { x: 0.10, y: 0.80 },   // neck, near the top of the torso
    frontUpper: { x: 0.12, y: 0.68 },   // shoulder
    backUpper:  { x: -0.10, y: 0.68 },
    frontFore:  { x: 0.00, y: -0.80 },  // elbow: bottom of the upper arm
    backFore:   { x: 0.00, y: -0.80 },
    frontThigh: { x: 0.08, y: -0.28 },  // hip
    backThigh:  { x: -0.08, y: -0.28 },
    frontShin:  { x: 0.00, y: -0.80 },  // knee
    backShin:   { x: 0.00, y: -0.80 },
  };

  for (const name of order) {
    const p = P[name];
    const joint = joints[name];
    if (!p || !joint) continue;
    const parentName = p.parent;
    if (!parentName || !joints[parentName]) { root.add(joint); continue; }
    joints[parentName].add(joint);
    const a = ATTACH[name] ?? { x: 0, y: 0 };
    const par = sizeOf(parentName);
    joint.position.set(a.x * par.w, a.y * par.h, 0);
  }

  // Lift the whole rig so the feet land on y=0 instead of the pelvis.
  const legDrop = (sizeOf('backThigh').h + sizeOf('backShin').h) * 0.82;
  if (joints.pelvis) joints.pelvis.position.y = legDrop;

  return {
    root, joints, meshes, scale: S, legDrop,
    height: unitPxHeight,
    /** @param {string} name @param {number} t 0..1 @param {number} time @param {number} seed @param {boolean} walking @param {number} blend */
    pose(name, t, time, seed, walking, blend) {
      const clip = clipInfo(name);
      const idle = idleTracks(time, seed, walking);
      for (const bone of ['torso', 'head', 'frontUpper', 'frontFore', 'backUpper', 'backFore',
        'frontThigh', 'frontShin', 'backThigh', 'backShin']) {
        const j = joints[bone];
        if (!j) continue;
        const idleV = idle[bone] ?? 0;
        const clipV = clip.tracks[bone] ? sample(clip.tracks[bone], t) : idleV;
        j.rotation.z = idleV * (1 - blend) + clipV * blend;
      }
      if (joints.pelvis) joints.pelvis.position.y = legDrop + idle.pelvisY * unitPxHeight;
    },
  };
}
