import * as THREE from "three";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const EPSILON = 1e-7;

export function tangentFor(radial, out = new THREE.Vector3()) {
  const flat = radial.clone().setY(0);
  if (flat.lengthSq() < EPSILON) return out.set(0, 0, 1);
  return out.crossVectors(flat.normalize(), Y_AXIS).normalize();
}

export function launchDirFor(source, target, arcRise) {
  const outward = source.clone().setY(0);
  if (outward.lengthSq() < EPSILON) outward.set(1, 0, 0);
  return target.clone()
    .sub(source)
    .addScaledVector(outward.normalize(), source.distanceTo(target) * arcRise)
    .normalize();
}

export function parabolaCoefficients(source, target, launchDir) {
  const delta = target.clone().sub(source);
  const velocity = launchDir.clone().normalize();
  // launchDirFor adds horizontal outward lift, so its matching stellar pull is
  // the horizontal direction back toward the star. This keeps y monotonic and
  // makes { velocity, gravity } span delta exactly for inclined planets.
  const gravity = source.clone().setY(0).multiplyScalar(-1);
  if (gravity.lengthSq() < EPSILON) gravity.set(-1, 0, 0);
  gravity.normalize();

  const velocityDelta = velocity.dot(delta);
  const gravityDelta = gravity.dot(delta);
  const alignment = velocity.dot(gravity);
  const denominator = 1 - alignment * alignment;
  if (denominator < EPSILON) return null;

  const velocityScale = (velocityDelta - alignment * gravityDelta) / denominator;
  const gravityScale = (gravityDelta - alignment * velocityDelta) / denominator;
  return { velocity, gravity, velocityScale, gravityScale };
}

export function parabolaPoint(source, coefficients, t, out = new THREE.Vector3()) {
  return out.copy(source)
    .addScaledVector(coefficients.velocity, coefficients.velocityScale * t)
    .addScaledVector(coefficients.gravity, coefficients.gravityScale * t * t);
}

export function parabolaTangent(coefficients, t, out = new THREE.Vector3()) {
  return out.copy(coefficients.velocity)
    .multiplyScalar(coefficients.velocityScale)
    .addScaledVector(coefficients.gravity, 2 * coefficients.gravityScale * t)
    .normalize();
}

export function horizontalHermite(p0, p1, t0, t1, t, out = new THREE.Vector3()) {
  const tt = t * t;
  const ttt = tt * t;
  const h00 = 2 * ttt - 3 * tt + 1;
  const h10 = ttt - 2 * tt + t;
  const h01 = -2 * ttt + 3 * tt;
  const h11 = ttt - tt;
  const chord = Math.max(EPSILON, Math.hypot(p1.x - p0.x, p1.z - p0.z));
  const m0 = Math.max(EPSILON, Math.hypot(t0.x, t0.z));
  const m1 = Math.max(EPSILON, Math.hypot(t1.x, t1.z));
  return out.set(
    h00 * p0.x + h01 * p1.x + chord * (h10 * t0.x / m0 + h11 * t1.x / m1),
    p0.y,
    h00 * p0.z + h01 * p1.z + chord * (h10 * t0.z / m0 + h11 * t1.z / m1),
  );
}

export function horizontalHermiteTangent(p0, p1, t0, t1, t, out = new THREE.Vector3()) {
  const tt = t * t;
  const h00 = 6 * tt - 6 * t;
  const h10 = 3 * tt - 4 * t + 1;
  const h01 = -6 * tt + 6 * t;
  const h11 = 3 * tt - 2 * t;
  const chord = Math.max(EPSILON, Math.hypot(p1.x - p0.x, p1.z - p0.z));
  const m0 = Math.max(EPSILON, Math.hypot(t0.x, t0.z));
  const m1 = Math.max(EPSILON, Math.hypot(t1.x, t1.z));
  return out.set(
    h00 * p0.x + h01 * p1.x + chord * (h10 * t0.x / m0 + h11 * t1.x / m1),
    0,
    h00 * p0.z + h01 * p1.z + chord * (h10 * t0.z / m0 + h11 * t1.z / m1),
  ).normalize();
}

export function horizontalTangentDot(from, to, tangent) {
  const direction = to.clone().sub(from).setY(0);
  const flatTangent = tangent.clone().setY(0);
  if (direction.lengthSq() < EPSILON || flatTangent.lengthSq() < EPSILON) return -1;
  return direction.normalize().dot(flatTangent.normalize());
}

export function buildShotTrajectory(source, seed, arrivalTime, config) {
  const {
    arcRise,
    cloudRadiusMin,
    cloudRadiusMax,
    entryRadius,
    orbitSpeedForRadius,
    random01,
    tangentCos,
  } = config;
  const sourceRadial = source.clone().setY(0);
  if (sourceRadial.lengthSq() < EPSILON) sourceRadial.set(1, 0, 0);
  sourceRadial.normalize();

  const seedRadius = cloudRadiusMin + Math.pow(random01(seed * 3 + 3), 0.58) * (cloudRadiusMax - cloudRadiusMin);
  const band = (random01(seed * 3 + 2) - 0.5) * 0.34;
  const seedHeight = Math.sin(band) * seedRadius * 0.34 + (random01(seed + 11) - 0.5) * 3.8;
  const injectionOffset = Math.floor(random01(seed + 71) * 12);

  for (let step = 0; step < 14; step += 1) {
    const maneuverAdvance = 0.18 + step * 0.055 + random01(seed + step * 17) * 0.035;
    for (let injectionStep = 0; injectionStep < 12; injectionStep += 1) {
      const slot = (injectionStep + injectionOffset) % 12;
      const injectionAdvance = 0.04 + slot * (0.36 / 11);
      // Three.js 绕 +Y 的负角才是 tangentFor 定义的顺公转方向。
      const seedRadial = sourceRadial.clone().applyAxisAngle(Y_AXIS, -(maneuverAdvance + injectionAdvance));
      const seedWorld = seedRadial.clone().multiplyScalar(seedRadius);
      seedWorld.y = seedHeight;

      // 先固定 seed，再从它反推入轨壁 maneuver；两点高度严格相等。
      const maneuverRadial = seedRadial.clone().applyAxisAngle(Y_AXIS, injectionAdvance);
      const maneuver = maneuverRadial.clone().multiplyScalar(entryRadius);
      maneuver.y = seedHeight;
      const velocity = launchDirFor(source, maneuver, arcRise);
      const coefficients = parabolaCoefficients(source, maneuver, velocity);
      if (!firstPhaseIsValid(source, maneuver, coefficients, entryRadius)) continue;

      const tangentManeuver = parabolaTangent(coefficients, 1);
      const tangentSeed = tangentFor(seedRadial);
      if (!secondPhaseIsValid(maneuver, seedWorld, tangentManeuver, tangentSeed, tangentCos)) continue;

      const seedBase = seedWorld.clone().applyAxisAngle(Y_AXIS, orbitSpeedForRadius(seedRadius) * arrivalTime);
      return { maneuver, seed: seedWorld, seedBase, coefficients, tangentManeuver, tangentSeed };
    }
  }
  return null;
}

export function firstPhaseIsValid(source, target, coefficients, entryRadius, samples = 64) {
  if (!coefficients) return false;
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const ringTangent = new THREE.Vector3();
  const cross = new THREE.Vector3();
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    parabolaPoint(source, coefficients, t, point);
    if (Math.hypot(point.x, point.z) < entryRadius - 1e-5) return false;
    parabolaTangent(coefficients, t, tangent).setY(0);
    tangentFor(point, ringTangent);
    if (cross.crossVectors(tangent, ringTangent).y <= EPSILON) return false;
  }
  parabolaPoint(source, coefficients, 1, point);
  return point.distanceToSquared(target) <= 1e-8;
}

export function secondPhaseIsValid(maneuver, seed, tangentManeuver, tangentSeed, tangentCos, samples = 32) {
  if (Math.abs(maneuver.y - seed.y) > 1e-6) return false;
  if (tangentManeuver.clone().setY(0).normalize().dot(tangentFor(maneuver)) < tangentCos) return false;
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    horizontalHermite(maneuver, seed, tangentManeuver, tangentSeed, t, point);
    horizontalHermiteTangent(maneuver, seed, tangentManeuver, tangentSeed, t, tangent);
    if (Math.abs(point.y - seed.y) > 1e-6) return false;
    if (tangent.dot(tangentFor(point)) <= EPSILON) return false;
  }
  horizontalHermite(maneuver, seed, tangentManeuver, tangentSeed, 1, point);
  return point.distanceToSquared(seed) <= 1e-8;
}
