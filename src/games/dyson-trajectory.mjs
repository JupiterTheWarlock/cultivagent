import * as THREE from "three";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const EPSILON = 1e-7;

export function tangentFor(radial, out = new THREE.Vector3()) {
  const flat = radial.clone().setY(0);
  if (flat.lengthSq() < EPSILON) return out.set(0, 0, 1);
  return out.crossVectors(flat.normalize(), Y_AXIS).normalize();
}

export function antipodalTarget(source, height, radius, out = new THREE.Vector3()) {
  out.copy(source).setY(0);
  if (out.lengthSq() < EPSILON) out.set(1, 0, 0);
  return out.normalize().multiplyScalar(-radius).setY(height);
}

// Solve source + v0*t + g*t^2 = target while forcing the terminal velocity
// onto the target's prograde tangent. This is the single 180-degree transfer.
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

export function buildShotTrajectory(source, seed, arrivalTime, config) {
  const {
    arcScale,
    cloudRadiusMin,
    cloudRadiusMax,
    orbitSpeedForRadius,
    random01,
    tangentCos,
  } = config;
  const seedRadius = Math.max(
    cloudRadiusMin,
    cloudRadiusMax - Math.pow(random01(seed * 3 + 3), 0.72) * 8,
  );
  const seedHeight = (random01(seed * 3 + 2) - 0.5) * seedRadius * 0.3;
  const seedWorld = antipodalTarget(source, seedHeight, seedRadius);
  const coefficients = parabolaCoefficients(
    source,
    seedWorld,
    arcScale * (0.97 + random01(seed + 97) * 0.06),
  );
  if (!firstPhaseIsValid(source, seedWorld, coefficients, seedRadius, tangentCos)) return null;

  const seedBase = seedWorld.clone().applyAxisAngle(Y_AXIS, orbitSpeedForRadius(seedRadius) * arrivalTime);
  return { seed: seedWorld, seedBase, coefficients };
}

export function firstPhaseIsValid(source, target, coefficients, targetRadius, tangentCos, samples = 64) {
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
    if (Math.hypot(point.x, point.z) < targetRadius - 1e-5) return false;
    parabolaTangent(coefficients, t, tangent).setY(0).normalize();
    if (tangent.dot(tangentFor(point, ringTangent)) <= EPSILON) return false;
  }
  parabolaPoint(source, coefficients, 1, point);
  parabolaTangent(coefficients, 1, tangent).setY(0).normalize();
  return point.distanceToSquared(target) <= 1e-8
    && tangent.dot(tangentFor(target, ringTangent)) >= tangentCos;
}
