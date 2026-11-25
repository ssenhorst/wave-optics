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
 * @file `src/core/imaging/prescription.js` reads an optical prescription off the scene.
 *
 * The scene is a general two-dimensional drawing in which anything may be anywhere. A screen that
 * shows the picture the system actually forms needs rather less than that, and rather more
 * structure: a list of surfaces of revolution about one common axis, in the order the light meets
 * them. This file is the translation between the two, and it is deliberately strict — an element
 * that is tilted, or off the axis, or of a type that has no meaning as a surface of revolution, is
 * reported rather than silently approximated, because an image drawn from a prescription that does
 * not match the drawing would be worse than no image at all.
 *
 * Only the elements an on-axis imaging exercise needs are understood: `SphericalLens`, `IdealLens`
 * and `Aperture`. Everything else in the scene — rulers, light sources, labels, the example rays —
 * is ignored, which is what lets the same scene be both a ray diagram and the thing that is traced.
 */

const AXIS_TOLERANCE = 1e-6;

/**
 * @typedef {Object} Prescription
 * @property {Array<Surface>} surfaces - The surfaces, ordered along the axis.
 * @property {number} axisY - The scene's y coordinate of the optical axis.
 * @property {number} ambientIndex - The index of the medium around the elements.
 * @property {Array<string>} warnings - What was left out, and why.
 */

/**
 * Whether two numbers agree to within the tolerance that matters for "on the same axis".
 * @param {number} a - The first number.
 * @param {number} b - The second number.
 * @param {number} tolerance - The tolerance.
 * @returns {boolean} Whether they agree.
 */
function near(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

/**
 * The two vertices of a built spherical lens, with the radius at each, in the order the light meets
 * them.
 *
 * `getDR1R2` reports the radii in the lens's own sense, which runs from `path[5]` to `path[2]`. When
 * that sense is opposite to the direction the light travels the lens is simply the same lens seen
 * from behind: the vertices swap and both radii change sign, because the sign convention is about
 * which side of the vertex the centre of curvature lies on.
 * @param {Object} lens - A `SphericalLens` scene object.
 * @returns {{front: Object, back: Object, r1: number, r2: number, semiAperture: number}|null} The
 * geometry, or null if the lens is not in a state that can be traced.
 */
function spherialLensGeometry(lens) {
  if (!lens.path || lens.path.length < 6) return null;

  const { r1, r2 } = lens.getDR1R2();
  let front = lens.path[5];
  let back = lens.path[2];
  let radiusFront = r1;
  let radiusBack = r2;

  if (front.x > back.x) {
    [front, back] = [back, front];
    [radiusFront, radiusBack] = [-radiusBack, -radiusFront];
  }

  const edge1 = midpoint(lens.path[0], lens.path[1]);
  const edge2 = midpoint(lens.path[3], lens.path[4]);
  const semiAperture = Math.hypot(edge1.x - edge2.x, edge1.y - edge2.y) / 2;

  return { front, back, r1: radiusFront, r2: radiusBack, semiAperture };
}

/**
 * The midpoint of two points.
 * @param {Point} a - The first point.
 * @param {Point} b - The second point.
 * @returns {Point} The midpoint.
 */
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Whether a lens or aperture stands perpendicular to the optical axis, which is the only orientation
 * that has a meaning as a surface of revolution about it.
 * @param {Point} a - One end of the element.
 * @param {Point} b - The other end.
 * @param {number} scale - The size of the element, used to set the tolerance.
 * @returns {boolean} Whether it is perpendicular to the axis.
 */
function isUpright(a, b, scale) {
  return near(a.x, b.x, Math.max(AXIS_TOLERANCE, 1e-3 * scale));
}

/**
 * Read the prescription of the on-axis imaging system in a scene.
 * @param {Scene} scene - The scene.
 * @param {number} axisY - The y coordinate of the optical axis, usually taken from the screen.
 * @param {Object} [options] - Options.
 * @param {number} [options.fromZ=-Infinity] - Ignore elements before this plane, which is how the
 * object itself and anything upstream of it is kept out of the prescription.
 * @param {number} [options.toZ=Infinity] - Ignore elements at or beyond this plane, so that the
 * screen does not trace the elements standing behind it.
 * @returns {Prescription} The prescription.
 */
export function readPrescription(scene, axisY, options = {}) {
  const fromZ = options.fromZ ?? -Infinity;
  const toZ = options.toZ ?? Infinity;
  const ambientIndex = 1;
  const surfaces = [];
  const warnings = [];

  for (const obj of scene.objs || []) {
    const type = obj?.constructor?.type;

    if (type === 'SphericalLens') {
      const geometry = spherialLensGeometry(obj);
      if (!geometry) {
        warnings.push(`the lens "${obj.name || 'unnamed'}" has no valid shape`);
        continue;
      }
      if (geometry.front.x < fromZ || geometry.back.x >= toZ) continue;

      const centre = midpoint(geometry.front, geometry.back);
      if (!near(centre.y, axisY, Math.max(AXIS_TOLERANCE, 1e-2 * geometry.semiAperture))) {
        warnings.push(`the lens "${obj.name || 'unnamed'}" is not centred on the optical axis`);
        continue;
      }
      if (!isUpright(geometry.front, geometry.back, geometry.semiAperture)
        && Math.abs(geometry.front.y - geometry.back.y) > 1e-2 * geometry.semiAperture) {
        warnings.push(`the lens "${obj.name || 'unnamed'}" is tilted`);
        continue;
      }

      surfaces.push({
        kind: 'spherical',
        z: geometry.front.x,
        radius: geometry.r1,
        semiAperture: geometry.semiAperture,
        nAfter: obj.refIndex,
        owner: obj.name || null,
      });
      surfaces.push({
        kind: 'spherical',
        z: geometry.back.x,
        radius: geometry.r2,
        semiAperture: geometry.semiAperture,
        nAfter: ambientIndex,
        owner: obj.name || null,
      });
    } else if (type === 'IdealLens') {
      if (!obj.p1 || !obj.p2) continue;
      const semiAperture = Math.hypot(obj.p1.x - obj.p2.x, obj.p1.y - obj.p2.y) / 2;
      const centre = midpoint(obj.p1, obj.p2);
      if (centre.x < fromZ || centre.x >= toZ) continue;
      if (!isUpright(obj.p1, obj.p2, semiAperture)) {
        warnings.push(`the ideal lens "${obj.name || 'unnamed'}" is tilted`);
        continue;
      }
      if (!near(centre.y, axisY, Math.max(AXIS_TOLERANCE, 1e-2 * semiAperture))) {
        warnings.push(`the ideal lens "${obj.name || 'unnamed'}" is not centred on the optical axis`);
        continue;
      }
      surfaces.push({
        kind: 'ideal',
        z: centre.x,
        focalLength: obj.focalLength,
        semiAperture,
        nAfter: ambientIndex,
        owner: obj.name || null,
      });
    } else if (type === 'Aperture') {
      if (!obj.p2 || !obj.p3) continue;
      const centre = midpoint(obj.p2, obj.p3);
      if (centre.x < fromZ || centre.x >= toZ) continue;
      const semiAperture = Math.abs(obj.p2.y - obj.p3.y) / 2;
      surfaces.push({
        kind: 'stop',
        z: centre.x,
        semiAperture,
        nAfter: ambientIndex,
        owner: obj.name || null,
      });
    }
  }

  surfaces.sort((a, b) => a.z - b.z);
  return { surfaces, axisY, ambientIndex, warnings };
}

/**
 * The total focusing power of the refracting elements of a prescription, as the sum of the powers of
 * its lenses.
 *
 * This is the quantity an exercise about splitting a lens holds fixed: the system has to keep
 * bending the light by the same total amount, so that what the student is changing is how that
 * bending is distributed rather than how strong it is.
 * @param {Scene} scene - The scene.
 * @param {Array<string>} [names] - The names of the lenses to include; by default every lens.
 * @returns {number} The summed power, in reciprocal scene units.
 */
export function totalLensPower(scene, names = null) {
  let power = 0;
  for (const obj of scene.objs || []) {
    const type = obj?.constructor?.type;
    if (type !== 'SphericalLens' && type !== 'IdealLens') continue;
    if (names && !names.includes(obj.name)) continue;

    if (type === 'IdealLens') {
      if (isFinite(obj.focalLength) && obj.focalLength !== 0) power += 1 / obj.focalLength;
    } else if (obj.path) {
      const { f } = obj.getDF();
      if (isFinite(f) && f !== 0) power += 1 / f;
    }
  }
  return power;
}
