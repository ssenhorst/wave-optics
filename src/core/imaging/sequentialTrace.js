/*
 * Copyright 2026 The Wave Optics Simulation authors and contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file `src/core/imaging/sequentialTrace.js` traces rays in three dimensions through a rotationally
 * symmetric, sequential optical system.
 *
 * The rest of the simulator works in the meridional plane, which is all a ray diagram needs. A
 * picture formed on a screen is a cross section perpendicular to that plane, and the rays that make
 * it are skew: they leave an off-axis object point and pass through a pupil point that is not in the
 * plane of the drawing. Coma and astigmatism live entirely in those rays, so a renderer that only
 * rotated the meridional trace would draw an image with the wrong aberrations — correct on axis and
 * quietly wrong everywhere else.
 *
 * What is here is therefore the classical sequential surface trace (Welford, *Aberrations of the
 * Symmetrical Optical System*): intersect the ray with the next surface of revolution, refract it
 * there by the vector form of Snell's law, repeat. It is exact for spherical surfaces — no paraxial
 * approximation and no aberration series anywhere — which is the point, since the exercise this
 * serves is about what happens when a system is pushed far outside the paraxial regime.
 *
 * Coordinates are right handed with **z along the optical axis**, increasing in the direction the
 * light travels, and the origin on the axis. The scene's x is z here, and the scene's y is y; x is
 * the direction out of the plane of the ray diagram.
 */

/**
 * @typedef {Object} Surface
 * @property {string} kind - `'spherical'`, `'ideal'` or `'stop'`.
 * @property {number} z - Where the surface meets the axis.
 * @property {number} [radius] - The radius of curvature of a spherical surface, positive when the
 * centre of curvature lies downstream of the vertex, or `Infinity` for a flat surface.
 * @property {number} [focalLength] - The focal length of an ideal surface.
 * @property {number} semiAperture - Half the clear aperture. A ray passing outside it is stopped,
 * which is what makes vignetting and the fall-off towards the corners of the picture come out.
 * @property {number} nAfter - The refractive index of the medium the ray enters.
 */

/**
 * @typedef {Object} Ray
 * @property {number} x - The out-of-plane coordinate.
 * @property {number} y - The in-plane transverse coordinate, the scene's y.
 * @property {number} z - The coordinate along the optical axis, the scene's x.
 * @property {number} dx - The x component of the (unit) direction.
 * @property {number} dy - The y component of the direction.
 * @property {number} dz - The z component of the direction.
 */

/**
 * Why a ray never reached the image.
 * @const {Object<string, string>}
 */
export const BLOCKED = {
  APERTURE: 'aperture',
  MISS: 'miss',
  TOTAL_REFLECTION: 'totalReflection',
  BACKWARDS: 'backwards',
};

const EPS = 1e-12;

/**
 * Intersect a ray with a surface of revolution and move it there.
 *
 * The two roots of the sphere are the two sheets the surface would have if it were complete; the one
 * meant is always the sheet through the vertex, which for light travelling towards +z is the nearer
 * root on a convex surface and the farther root on a concave one.
 * @param {Ray} ray - The ray, modified in place.
 * @param {number} z - The vertex of the surface.
 * @param {number} radius - The radius of curvature, or `Infinity`.
 * @returns {Array<number>|null} The unit normal at the intersection, pointing back towards the
 * incoming light, or null if the ray misses the surface altogether.
 */
function intersect(ray, z, radius) {
  if (ray.dz <= EPS) return null;

  if (!isFinite(radius)) {
    const t = (z - ray.z) / ray.dz;
    if (t < 0) return null;
    ray.x += t * ray.dx;
    ray.y += t * ray.dy;
    ray.z = z;
    return [0, 0, -1];
  }

  // Local coordinates with the vertex at the origin, so that the centre of curvature is at z = R.
  const ox = ray.x;
  const oy = ray.y;
  const oz = ray.z - z - radius;

  const b = ox * ray.dx + oy * ray.dy + oz * ray.dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;

  const t = -b - Math.sign(radius) * Math.sqrt(disc);
  if (t < 0) return null;

  ray.x += t * ray.dx;
  ray.y += t * ray.dy;
  ray.z += t * ray.dz;

  // (P - C) / R points against the propagation at the vertex for either sign of R.
  return [ray.x / radius, ray.y / radius, (ray.z - z - radius) / radius];
}

/**
 * Refract a ray at a surface by the vector form of Snell's law.
 * @param {Ray} ray - The ray, modified in place.
 * @param {Array<number>} normal - The unit normal, pointing back towards the incoming light.
 * @param {number} nBefore - The index of the medium the ray is in.
 * @param {number} nAfter - The index of the medium it enters.
 * @returns {boolean} Whether the ray was refracted, false on total internal reflection.
 */
function refract(ray, normal, nBefore, nAfter, stats) {
  const mu = nBefore / nAfter;
  let [nx, ny, nz] = normal;

  let cosI = -(nx * ray.dx + ny * ray.dy + nz * ray.dz);
  if (cosI < 0) {
    // The ray met the back of the surface; flip the normal so the formula below still refers to the
    // side the light came from.
    nx = -nx; ny = -ny; nz = -nz;
    cosI = -cosI;
  }

  if (stats) {
    // How steeply the ray met the glass. This is the quantity the whole exercise turns on: a
    // surface refracts a ray by an amount that grows faster than linearly with this angle, so the
    // aberration of a system is governed by the steepest angles anywhere in it, and splitting the
    // focusing between several gentle surfaces is what brings those angles down.
    const incidence = Math.acos(Math.min(1, cosI));
    if (incidence > stats.maxIncidence) stats.maxIncidence = incidence;
  }

  const k = 1 - mu * mu * (1 - cosI * cosI);
  if (k < 0) return false;

  const f = mu * cosI - Math.sqrt(k);
  ray.dx = mu * ray.dx + f * nx;
  ray.dy = mu * ray.dy + f * ny;
  ray.dz = mu * ray.dz + f * nz;

  const len = Math.hypot(ray.dx, ray.dy, ray.dz);
  ray.dx /= len; ray.dy /= len; ray.dz /= len;
  return true;
}

/**
 * Bend a ray by an ideal thin lens: every ray through the same point of the object plane is sent to
 * the same point of the image plane, by construction, with no aberration of any order.
 * @param {Ray} ray - The ray, modified in place, already at the plane of the lens.
 * @param {number} focalLength - The focal length.
 */
function bendIdeally(ray, focalLength) {
  // In terms of the slopes the thin-lens law is simply a shear, which is what makes it ideal.
  const u = ray.dx / ray.dz - ray.x / focalLength;
  const v = ray.dy / ray.dz - ray.y / focalLength;
  const len = Math.hypot(u, v, 1);
  ray.dx = u / len;
  ray.dy = v / len;
  ray.dz = 1 / len;
}

/**
 * Trace one ray through the whole system.
 * @param {Array<Surface>} surfaces - The surfaces, ordered along the axis.
 * @param {Ray} ray - The starting ray, which is consumed; pass a copy to keep it.
 * @param {number} [nStart=1] - The index of the medium the ray starts in.
 * @param {{maxIncidence: number}} [stats] - Collects the steepest angle of incidence the ray met,
 * in radians, across however many rays are traced into the same object.
 * @returns {{ray: Ray, blocked: null}|{ray: null, blocked: string}} The ray as it leaves the last
 * surface, or why it did not get there.
 */
export function traceRay(surfaces, ray, nStart = 1, stats = null) {
  let n = nStart;

  for (let i = 0; i < surfaces.length; i++) {
    const surface = surfaces[i];

    if (surface.kind === 'spherical') {
      const normal = intersect(ray, surface.z, surface.radius);
      if (!normal) return { ray: null, blocked: BLOCKED.MISS };
      if (Math.hypot(ray.x, ray.y) > surface.semiAperture) {
        return { ray: null, blocked: BLOCKED.APERTURE };
      }
      if (!refract(ray, normal, n, surface.nAfter, stats)) {
        return { ray: null, blocked: BLOCKED.TOTAL_REFLECTION };
      }
    } else {
      // Ideal surfaces and stops are both plane.
      if (!intersect(ray, surface.z, Infinity)) {
        return { ray: null, blocked: BLOCKED.BACKWARDS };
      }
      if (Math.hypot(ray.x, ray.y) > surface.semiAperture) {
        return { ray: null, blocked: BLOCKED.APERTURE };
      }
      if (surface.kind === 'ideal') bendIdeally(ray, surface.focalLength);
    }

    n = surface.nAfter;
  }

  if (ray.dz <= EPS) return { ray: null, blocked: BLOCKED.BACKWARDS };
  return { ray, blocked: null };
}

/**
 * Move a ray along a straight line to a plane perpendicular to the axis.
 * @param {Ray} ray - The ray, modified in place.
 * @param {number} z - The plane.
 * @returns {Ray|null} The ray, or null if the plane is behind it.
 */
export function propagateToPlane(ray, z) {
  if (ray.dz <= EPS) return null;
  const t = (z - ray.z) / ray.dz;
  if (t < 0) return null;
  ray.x += t * ray.dx;
  ray.y += t * ray.dy;
  ray.z = z;
  return ray;
}

/**
 * The paraxial properties of a system, by tracing one ray so close to the axis that no aberration
 * can show. This is what gives the textbook answer a student is asked to compare the real image
 * against: where the image would be, and how large, if the lenses were ideal.
 * @param {Array<Surface>} surfaces - The surfaces.
 * @param {number} objectZ - The object plane.
 * @param {number} [nStart=1] - The index of the medium in front of the system.
 * @returns {{imageZ: number, magnification: number}|null} Where the paraxial image plane is and the
 * transverse magnification there, or null if the system forms no image.
 */
export function paraxialImage(surfaces, objectZ, nStart = 1) {
  if (surfaces.length === 0) return null;

  // A height small enough that the fourth-order terms of the aberration are far below rounding, but
  // large enough that the trace itself stays well conditioned.
  const h = 1e-4 * Math.max(1, Math.abs(surfaces[0].z - objectZ));

  // The marginal ray: from the axial object point through the rim of the (scaled-down) first
  // surface. Where it crosses the axis again is the paraxial image.
  const marginal = traceRay(surfaces, {
    x: 0, y: 0, z: objectZ,
    ...normalizedDirection(0, h, surfaces[0].z - objectZ),
  }, nStart);
  if (!marginal.ray) return null;
  if (Math.abs(marginal.ray.dy) < EPS) return null;
  const imageZ = marginal.ray.z - marginal.ray.y * (marginal.ray.dz / marginal.ray.dy);
  if (!isFinite(imageZ) || imageZ <= surfaces[surfaces.length - 1].z) return null;

  // A second ray from an off-axis point of the object gives the magnification at that plane.
  const chief = traceRay(surfaces, {
    x: 0, y: h, z: objectZ,
    ...normalizedDirection(0, -h, surfaces[0].z - objectZ),
  }, nStart);
  if (!chief.ray) return null;
  const landed = propagateToPlane(chief.ray, imageZ);
  if (!landed) return null;

  return { imageZ, magnification: landed.y / h };
}

/**
 * A unit direction vector from its components.
 * @param {number} dx - The x component.
 * @param {number} dy - The y component.
 * @param {number} dz - The z component.
 * @returns {{dx: number, dy: number, dz: number}} The normalized direction.
 */
export function normalizedDirection(dx, dy, dz) {
  const len = Math.hypot(dx, dy, dz);
  return { dx: dx / len, dy: dy / len, dz: dz / len };
}
