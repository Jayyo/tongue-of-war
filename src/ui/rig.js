// @ts-check
// A real (if small) skeletal rig for the battlefield units.
//
// WHY NOT ONE SPRITE: sliding a single flat image back and forth reads as cheap,
// not as a fight. WHY NOT FULL 3D SKINNING: generated 3D meshes come without an
// armature, and a retopo->rig->skin->retarget pipeline is out of scope here.
//
// The middle path used here is a cut-out bone rig:
//
//        ┌ head      (bobs, leans into the swing)
//   root ┼ torso     (rotates, squashes)
//        │  └ armFront ─ weapon   (the bone that actually performs the attack)
//        └ legs      (counter-rotates so the figure doesn't skate)
//
// The BODY stays one texture (identity never drifts), and the WEAPON is its own
// texture on its own bone. That single split is enough for an archer to raise a
// bow, draw, hold, and loose, and for a guard to wind up and slam.
//
// Poses are authored as keyframes in normalised time and interpolated, so the
// same rig plays melee, ranged and cast without new art.

/** @typedef {{rot:number, x:number, y:number, scale:number}} BonePose */

const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;

/**
 * Attack clips, normalised to 0..1 of the attack window.
 * Each entry: [time, weaponRot(rad), weaponReach, torsoRot, torsoPush]
 * weaponReach/torsoPush are in unit-heights, so they scale with the sprite.
 */
const CLIPS = {
  // wind up back, then slam forward and settle
  melee: [
    [0.00, -0.30, 0.00, -0.06, 0.00],
    [0.22, -1.15, -0.06, -0.16, -0.05],   // cock the arm back
    [0.42, 1.05, 0.30, 0.20, 0.16],       // strike through
    [0.62, 0.55, 0.16, 0.10, 0.07],
    [1.00, -0.30, 0.00, -0.06, 0.00],
  ],
  // thrust: less rotation, more reach
  thrust: [
    [0.00, -0.10, 0.00, -0.04, 0.00],
    [0.20, -0.45, -0.08, -0.12, -0.06],
    [0.38, 0.05, 0.42, 0.06, 0.20],       // lunge
    [0.60, 0.00, 0.18, 0.02, 0.08],
    [1.00, -0.10, 0.00, -0.04, 0.00],
  ],
  // BOW: raise, draw (hold), loose, recover. The recoil is what sells it.
  bow: [
    [0.00, -0.20, 0.00, 0.00, 0.00],
    [0.18, -0.62, 0.04, -0.04, 0.00],     // raise the bow
    [0.46, -0.72, 0.06, -0.07, -0.04],    // full draw, lean back
    [0.54, -0.72, 0.06, -0.07, -0.04],    // hold
    [0.60, -0.40, -0.10, 0.05, 0.05],     // loose: snap forward
    [0.78, -0.28, 0.00, 0.01, 0.01],
    [1.00, -0.20, 0.00, 0.00, 0.00],
  ],
  // artillery/caster: heave the tube up, boom, recoil down
  cast: [
    [0.00, -0.55, 0.00, 0.00, 0.00],
    [0.28, -0.95, 0.05, -0.08, -0.03],    // elevate
    [0.48, -0.80, 0.02, 0.10, -0.10],     // fire + kick back
    [0.72, -0.62, 0.00, 0.03, -0.02],
    [1.00, -0.55, 0.00, 0.00, 0.00],
  ],
};

/** Idle/walk cycle, applied whenever no attack clip is active. */
export function idlePose(t, seed, walking) {
  const f = walking ? 6.4 : 2.1;
  const amp = walking ? 1 : 0.35;
  const ph = t * f + seed;
  return {
    bodyBob: Math.sin(ph) * 0.035 * amp,
    bodyLean: Math.sin(ph) * 0.045 * amp,
    legSwing: walking ? Math.sin(ph) * 0.26 : 0,
    weaponRot: Math.sin(ph * 0.5) * 0.06 * amp,
    weaponReach: 0,
    torsoRot: 0,
    torsoPush: 0,
  };
}

/** Which clip a unit uses, decided by how it actually fights. */
export function clipFor(u) {
  if (u.role === 'artillery') return u.channel === 'arcane' ? 'cast' : 'bow';
  if (u.role === 'raider') return 'thrust';
  return 'melee';
}

/**
 * Sample an attack clip.
 * @param {string} name
 * @param {number} p 0..1 through the attack
 */
export function samplePose(name, p) {
  const clip = CLIPS[name] ?? CLIPS.melee;
  const t = Math.max(0, Math.min(1, p));
  let a = clip[0], b = clip[clip.length - 1];
  for (let i = 0; i < clip.length - 1; i++) {
    if (t >= clip[i][0] && t <= clip[i + 1][0]) { a = clip[i]; b = clip[i + 1]; break; }
  }
  const span = Math.max(1e-4, b[0] - a[0]);
  const raw = (t - a[0]) / span;
  // strike phases snap, recovery phases settle
  const k = b[1] > a[1] ? easeOut(raw) : easeIn(raw);
  return {
    weaponRot: lerp(a[1], b[1], k),
    weaponReach: lerp(a[2], b[2], k),
    torsoRot: lerp(a[3], b[3], k),
    torsoPush: lerp(a[4], b[4], k),
  };
}

/**
 * The moment in the clip where damage/projectile visually happens.
 * Used so the arrow leaves the bow at the loose, not at the wind-up.
 */
export const RELEASE_AT = { melee: 0.42, thrust: 0.38, bow: 0.60, cast: 0.48 };

/** How long one attack animation plays, clamped so fast units still read. */
export function clipDuration(cadence) {
  return Math.max(0.34, Math.min(0.9, cadence * 0.85));
}

/** Where the weapon hangs off the body, per role, in unit-heights. */
// Weapon art is authored on a square canvas with the object letterboxed inside,
// so the visible weapon is much smaller than the texture. These scales are tuned
// against the RENDERED result, not the texture size.
export const GRIP = {
  guard:     { x: 0.26, y: 0.42, scale: 0.44 },
  raider:    { x: 0.28, y: 0.44, scale: 0.46 },
  artillery: { x: 0.16, y: 0.54, scale: 0.52 },
};
