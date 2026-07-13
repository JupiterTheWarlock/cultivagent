import * as THREE from "three";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const EPSILON = 1e-7;
const TWO_PI = Math.PI * 2;

export function tangentFor(radial, out = new THREE.Vector3()) {
  const flat = radial.clone().setY(0);
  if (flat.lengthSq() < EPSILON) return out.set(0, 0, 1);
  return out.crossVectors(flat.normalize(), Y_AXIS).normalize();
}

export function antipodalManeuver(source, height, entryRadius, out = new THREE.Vector3()) {
  out.copy(source).setY(0);
  if (out.lengthSq() < EPSILON) out.set(1, 0, 0);
  return out.normalize().multiplyScalar(-entryRadius).setY(height);
}

// Solve source + v0*t + g*t^2 = target while forcing the terminal velocity
// onto the target's prograde tangent. The resulting quadratic is the visual
// constant-gravity approximation of the 180-degree stellar transfer.
export function parabolaCoefficients(source, target, arcScale) {
  const delta = target.clone().sub(source);
  const transferRadius = Math.hypot(source.x, source.z) + Math.hypot(target.x, target.z);
  const terminalVelocity = tangentFor(target).multiplyScalar(transferRadius * arcScale);
  const gravity = terminalVelocity.clone().sub(delta);
  const velocity = delta.clone().sub(gravity);
  if (velocity.lengthSq() < EPSILON || gravity.lengthSq() < EPSILON) return null;
  return {
    velocity: velocity.clone().normalize(),
    gravity: gravity.clone().normalize(),
    velocityScale: velocity.length(),
    gravityScale: gravity.length(),
  };
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

export function progradeAngle(from, to) {
  const start = Math.atan2(from.z, from.x);
  const end = Math.atan2(to.z, to.x);
  return (end - start + TWO_PI) % TWO_PI;
}

export function horizontalOrbitArc(p0, p1, t, out = new THREE.Vector3()) {
  const radius0 = Math.hypot(p0.x, p0.z);
  const radius1 = Math.hypot(p1.x, p1.z);
  const radialT = t * t * (3 - 2 * t);
  const angle = Math.atan2(p0.z, p0.x) + progradeAngle(p0, p1) * t;
  const radius = THREE.MathUtils.lerp(radius0, radius1, radialT);
  return out.set(Math.cos(angle) * radius, p0.y, Math.sin(angle) * radius);
}

export function horizontalOrbitArcTangent(p0, p1, t, out = new THREE.Vector3()) {
  const radius0 = Math.hypot(p0.x, p0.z);
  const radius1 = Math.hypot(p1.x, p1.z);
  const deltaAngle = progradeAngle(p0, p1);
  const radialT = t * t * (3 - 2 * t);
  const radius = THREE.MathUtils.lerp(radius0, radius1, radialT);
  const radialSpeed = (radius1 - radius0) * 6 * t * (1 - t);
  const angle = Math.atan2(p0.z, p0.x) + deltaAngle * t;
  return out.set(
    radialSpeed * Math.cos(angle) - radius * deltaAngle * Math.sin(angle),
    0,
    radialSpeed * Math.sin(angle) + radius * deltaAngle * Math.cos(angle),
  ).normalize();
}

export function buildShotTrajectory(source, seed, arrivalTime, config) {
  const {
    arcScale,
    cloudRadiusMin,
    cloudRadiusMax,
    entryRadius,
    orbitSpeedForRadius,
    random01,
    tangentCos,
  } = config;
  const seedRadius = Math.max(
    cloudRadiusMin,
    cloudRadiusMax - Math.pow(random01(seed * 3 + 3), 0.72) * 8,
  );
  const seedHeight = (random01(seed * 3 + 2) - 0.5) * seedRadius * 0.3;
  const maneuver = antipodalManeuver(source, seedHeight, entryRadius);
  const injectionAngle = 0.08 + random01(seed + 71) * 0.14;
  const seedRadial = maneuver.clone().setY(0).normalize().applyAxisAngle(Y_AXIS, -injectionAngle);
  const seedWorld = seedRadial.clone().multiplyScalar(seedRadius).setY(seedHeight);
  const coefficients = parabolaCoefficients(
    source,
    maneuver,
    arcScale * (0.97 + random01(seed + 97) * 0.06),
  );
  if (!firstPhaseIsValid(source, maneuver, coefficients, entryRadius, tangentCos)) return null;

  const tangentManeuver = parabolaTangent(coefficients, 1);
  const tangentSeed = tangentFor(seedRadial);
  if (!secondPhaseIsValid(maneuver, seedWorld, tangentManeuver, tangentSeed, tangentCos)) return null;

  const seedBase = seedWorld.clone().applyAxisAngle(Y_AXIS, orbitSpeedForRadius(seedRadius) * arrivalTime);
  return { maneuver, seed: seedWorld, seedBase, coefficients, tangentManeuver, tangentSeed, injectionAngle };
}

export function firstPhaseIsValid(source, target, coefficients, entryRadius, tangentCos, samples = 64) {
  if (!coefficients) return false;
  const sourceRadial = source.clone().setY(0).normalize();
  const targetRadial = target.clone().setY(0).normalize();
  if (sourceRadial.dot(targetRadial) > -1 + 1e-6) return false;

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const ringTangent = new THREE.Vector3();
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    parabolaPoint(source, coefficients, t, point);
    if (Math.hypot(point.x, point.z) < entryRadius - 1e-5) return false;
    parabolaTangent(coefficients, t, tangent).setY(0).normalize();
    if (tangent.dot(tangentFor(point, ringTangent)) <= EPSILON) return false;
  }
  parabolaPoint(source, coefficients, 1, point);
  parabolaTangent(coefficients, 1, tangent).setY(0).normalize();
  return point.distanceToSquared(target) <= 1e-8
    && tangent.dot(tangentFor(target, ringTangent)) >= tangentCos;
}

export function secondPhaseIsValid(maneuver, seed, tangentManeuver, tangentSeed, tangentCos, samples = 32) {
  if (Math.abs(maneuver.y - seed.y) > 1e-6) return false;
  const angle = progradeAngle(maneuver, seed);
  if (angle <= EPSILON || angle > Math.acos(tangentCos)) return false;
  if (tangentManeuver.clone().setY(0).normalize().dot(tangentFor(maneuver)) < tangentCos) return false;

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    horizontalOrbitArc(maneuver, seed, t, point);
    horizontalOrbitArcTangent(maneuver, seed, t, tangent);
    if (Math.abs(point.y - seed.y) > 1e-6) return false;
    if (tangent.dot(tangentFor(point)) <= EPSILON) return false;
  }
  horizontalOrbitArc(maneuver, seed, 1, point);
  horizontalOrbitArcTangent(maneuver, seed, 1, tangent);
  return point.distanceToSquared(seed) <= 1e-8
    && tangent.dot(tangentSeed) >= tangentCos;
}
