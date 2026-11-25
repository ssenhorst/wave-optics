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
 * @file Checks the sequential surface trace against results that can be derived independently: the
 * thick-lens maker's equation, the sign of the spherical aberration of a positive singlet, and the
 * rule that bending a lens changes that aberration while leaving its focal length alone.
 */

import {
  traceRay, propagateToPlane, paraxialImage, normalizedDirection,
} from '../../src/core/imaging/sequentialTrace.js';
import { traceSpotField, renderScreenImage, RENDER_QUALITY } from '../../src/core/imaging/screenRenderer.js';

/**
 * A thick spherical lens as two surfaces.
 * @param {Object} params - The lens.
 * @returns {Array<Object>} The surfaces.
 */
function singlet({ z = 0, r1, r2, thickness = 10, n = 1.5, semiAperture = 40 }) {
  return [
    { kind: 'spherical', z, radius: r1, semiAperture, nAfter: n },
    { kind: 'spherical', z: z + thickness, radius: r2, semiAperture, nAfter: 1 },
  ];
}

/**
 * The focal length of a thick lens from the maker's equation.
 * @param {Object} params - The lens.
 * @returns {number} The effective focal length.
 */
function thickLensFocalLength({ r1, r2, thickness, n }) {
  const power = (n - 1) * (1 / r1 - 1 / r2 + (n - 1) * thickness / (n * r1 * r2));
  return 1 / power;
}

describe('sequential surface trace', () => {
  test('a flat surface does not bend an axial ray', () => {
    const surfaces = [{ kind: 'spherical', z: 10, radius: Infinity, semiAperture: 50, nAfter: 1.5 }];
    const { ray } = traceRay(surfaces, { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1 });
    expect(ray.z).toBeCloseTo(10, 9);
    expect(ray.dy).toBeCloseTo(0, 12);
  });

  test('Snell\'s law holds at a flat surface for an oblique ray', () => {
    const n = 1.6;
    const incidence = 0.4;
    const surfaces = [{ kind: 'spherical', z: 10, radius: Infinity, semiAperture: 50, nAfter: n }];
    const { ray } = traceRay(surfaces, {
      x: 0, y: 0, z: 0, ...normalizedDirection(0, Math.sin(incidence), Math.cos(incidence)),
    });
    const refracted = Math.asin(ray.dy);
    expect(Math.sin(incidence)).toBeCloseTo(n * Math.sin(refracted), 10);
  });

  test('the effective focal length of a singlet matches the thick-lens maker\'s equation', () => {
    const lens = { r1: 150, r2: -150, thickness: 8, n: 1.5 };
    const surfaces = singlet({ z: 0, ...lens, semiAperture: 30 });
    const f = thickLensFocalLength(lens);

    // The effective focal length is the incoming height of a collimated ray divided by the tangent
    // of the angle it leaves at, which is the definition and needs no principal planes.
    const height = 0.02;
    const { ray } = traceRay(surfaces, { x: 0, y: height, z: -50, dx: 0, dy: 0, dz: 1 });
    // The effective focal length uses the height the ray came in at, not the height it left the
    // last surface at; the difference between the two is the back principal plane.
    const measured = height / (-ray.dy / ray.dz);
    expect(measured).toBeCloseTo(f, 3);
  });

  test('a positive singlet has undercorrected spherical aberration', () => {
    // The surfaces must not meet before the rim: at a semi-aperture of 30 each face of a 150 mm
    // radius sags about 3 units, so 8 units of centre thickness leaves the lens buildable.
    const surfaces = singlet({ z: 0, r1: 150, r2: -150, thickness: 8, n: 1.5, semiAperture: 30 });
    const objectZ = -600;
    const paraxial = paraxialImage(surfaces, objectZ);

    const crossing = (height) => {
      const { ray } = traceRay(surfaces, {
        x: 0, y: 0, z: objectZ, ...normalizedDirection(0, height, -objectZ),
      });
      expect(ray).not.toBeNull();
      return ray.z - ray.y * (ray.dz / ray.dy);
    };

    // The marginal ray crosses the axis nearer the lens than the paraxial one does. That is the
    // sign every simple positive lens has, and it is why the exercise's image blurs.
    expect(crossing(28)).toBeLessThan(paraxial.imageZ);
    expect(crossing(0.5)).toBeCloseTo(paraxial.imageZ, 0);
  });

  test('bending a lens changes its spherical aberration but not its focal length', () => {
    const equiconvex = { r1: 100, r2: -100, thickness: 8, n: 1.5 };
    const f = thickLensFocalLength(equiconvex);

    // A meniscus of the same focal length: strongly bent, far from best form.
    let r1 = 30;
    let r2 = solveSecondRadius(r1, f, equiconvex.thickness, equiconvex.n);
    const bent = { r1, r2, thickness: 8, n: 1.5 };
    expect(thickLensFocalLength(bent)).toBeCloseTo(f, 6);

    const objectZ = -600;
    const blur = (lens) => {
      const surfaces = singlet({ z: 0, ...lens, semiAperture: 25 });
      const paraxial = paraxialImage(surfaces, objectZ);
      const { ray } = traceRay(surfaces, {
        x: 0, y: 0, z: objectZ, ...normalizedDirection(0, 22, -objectZ),
      });
      if (!ray) return Infinity;
      const landed = propagateToPlane(ray, paraxial.imageZ);
      return Math.abs(landed.y);
    };

    expect(blur(bent)).toBeGreaterThan(blur(equiconvex));
  });

  test('an ideal surface forms a perfectly sharp image', () => {
    const surfaces = [{ kind: 'ideal', z: 0, focalLength: 150, semiAperture: 60, nAfter: 1 }];
    const objectZ = -450;
    const paraxial = paraxialImage(surfaces, objectZ);
    expect(paraxial.imageZ).toBeCloseTo(225, 6);

    for (const height of [5, 30, 59]) {
      const { ray } = traceRay(surfaces, {
        x: 0, y: 0, z: objectZ, ...normalizedDirection(0, height, -objectZ),
      });
      const landed = propagateToPlane(ray, paraxial.imageZ);
      expect(landed.y).toBeCloseTo(0, 8);
    }
  });

  test('splitting a lens in two reduces the blur at the same total power', () => {
    const objectZ = -700;
    const n = 1.5;

    // One strong equiconvex lens.
    const single = singlet({ z: 0, r1: 90, r2: -90, thickness: 14, n, semiAperture: 30 });

    // The same total power as two weaker equiconvex lenses close together.
    const weakR = 180;
    const split = [
      ...singlet({ z: 0, r1: weakR, r2: -weakR, thickness: 8, n, semiAperture: 30 }),
      ...singlet({ z: 40, r1: weakR, r2: -weakR, thickness: 8, n, semiAperture: 30 }),
    ];

    const spotRms = (surfaces) => {
      const paraxial = paraxialImage(surfaces, objectZ);
      const field = traceSpotField({
        surfaces, objectZ, objectRadius: 1e-6, screenZ: paraxial.imageZ,
        ambientIndex: 1, fieldSamples: 2, pupilSamples: 400,
      });
      return field.spots[0].rms;
    };

    expect(spotRms(split)).toBeLessThan(spotRms(single));
  });
});

describe('screen rendering', () => {
  const objectZ = -700;
  const surfaces = singlet({ z: 0, r1: 90, r2: -90, thickness: 14, n: 1.5, semiAperture: 30 });

  /**
   * A small test object: a bright square on a transparent field.
   * @param {number} size - The side in pixels.
   * @returns {Object} The texture.
   */
  function squareTexture(size) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = x > size * 0.25 && x < size * 0.75 && y > size * 0.25 && y < size * 0.75;
        const i = (y * size + x) * 4;
        data[i] = inside ? 255 : 0;
        data[i + 1] = inside ? 255 : 0;
        data[i + 2] = inside ? 255 : 0;
        data[i + 3] = inside ? 255 : 0;
      }
    }
    return { data, width: size, height: size };
  }

  test('a picture is rendered and the energy lands on the screen', () => {
    const paraxial = paraxialImage(surfaces, objectZ);
    const field = traceSpotField({
      surfaces, objectZ, objectRadius: 30, screenZ: paraxial.imageZ,
      ambientIndex: 1, fieldSamples: 8, pupilSamples: 200,
    });
    const picture = renderScreenImage({
      texture: squareTexture(48),
      objectHalfHeight: 25,
      spots: field.spots,
      objectRadius: 30,
      screenHalfSize: Math.abs(paraxial.magnification) * 30 * 1.4,
      outputSize: 96,
    });

    expect(picture.width).toBe(96);
    expect(picture.energy).toBeGreaterThan(0);
    const lit = Array.from(picture.data).filter((_, i) => i % 4 === 0).filter(v => v > 10).length;
    expect(lit).toBeGreaterThan(50);
  });

  test('a full-quality render is fast enough to be interactive', () => {
    const paraxial = paraxialImage(surfaces, objectZ);
    const quality = RENDER_QUALITY.full;
    const texture = squareTexture(quality.objectSize);

    const start = Date.now();
    const field = traceSpotField({
      surfaces, objectZ, objectRadius: 30, screenZ: paraxial.imageZ,
      ambientIndex: 1,
      fieldSamples: quality.fieldSamples, pupilSamples: quality.pupilSamples,
    });
    const traceMs = Date.now() - start;

    const renderStart = Date.now();
    renderScreenImage({
      texture,
      objectHalfHeight: 25,
      spots: field.spots,
      objectRadius: 30,
      screenHalfSize: Math.abs(paraxial.magnification) * 30 * 1.4,
      outputSize: quality.outputSize,
    });
    const renderMs = Date.now() - renderStart;

    console.log(`trace ${traceMs} ms, render ${renderMs} ms, total ${traceMs + renderMs} ms`);
    expect(traceMs + renderMs).toBeLessThan(4000);
  });
});

/**
 * The second radius that gives a thick lens a required focal length.
 * @param {number} r1 - The first radius.
 * @param {number} f - The required focal length.
 * @param {number} thickness - The centre thickness.
 * @param {number} n - The refractive index.
 * @returns {number} The second radius.
 */
function solveSecondRadius(r1, f, thickness, n) {
  // 1/f = (n-1)[1/r1 - 1/r2 + (n-1) t / (n r1 r2)], linear in 1/r2.
  const a = 1 / (f * (n - 1)) - 1 / r1;
  const b = -1 + (n - 1) * thickness / (n * r1);
  return b / a;
}
