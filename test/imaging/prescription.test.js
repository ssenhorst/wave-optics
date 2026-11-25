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
 * @file Checks the join between the two-dimensional scene and the three-dimensional trace.
 *
 * This is where a sign convention can go wrong without anything looking wrong: a lens read back to
 * front still forms an image, just not the one the diagram shows. So the prescription read off a
 * scene is checked against what the scene object itself says its focal length is, and against the
 * ray diagram's own answer for where the image lands.
 */

import Scene from '../../src/core/Scene.js';
import SphericalLens from '../../src/core/sceneObjs/glass/SphericalLens.js';
import IdealLens from '../../src/core/sceneObjs/glass/IdealLens.js';
import ImageScreen from '../../src/core/sceneObjs/other/ImageScreen.js';
import { readPrescription, totalLensPower } from '../../src/core/imaging/prescription.js';
import { paraxialImage, traceRay, normalizedDirection } from '../../src/core/imaging/sequentialTrace.js';

const AXIS_Y = 400;

/**
 * A scene with the optical axis at y = AXIS_Y.
 * @returns {Scene} The scene.
 */
function makeScene() {
  const scene = new Scene();
  scene.setViewportSize(1600, 800);
  return scene;
}

/**
 * Add a spherical lens given by its thickness and focal length.
 * @param {Scene} scene - The scene.
 * @param {Object} params - The lens.
 * @returns {SphericalLens} The lens.
 */
function addLens(scene, { x, halfAperture, d, f, refIndex = 1.5, name = 'Lens' }) {
  const lens = new SphericalLens(scene, {
    name,
    defBy: 'DF',
    p1: { x, y: AXIS_Y - halfAperture },
    p2: { x, y: AXIS_Y + halfAperture },
    params: { d, f },
    refIndex,
    partialReflect: false,
  });
  scene.objs.push(lens);
  return lens;
}

describe('reading a prescription off a scene', () => {
  test('a spherical lens gives two surfaces with the focal length it reports', () => {
    const scene = makeScene();
    const lens = addLens(scene, { x: 600, halfAperture: 60, d: 14, f: 200 });

    const { surfaces, warnings } = readPrescription(scene, AXIS_Y);
    expect(warnings).toEqual([]);
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0].z).toBeLessThan(surfaces[1].z);
    expect(surfaces[0].nAfter).toBeCloseTo(1.5, 10);
    expect(surfaces[1].nAfter).toBeCloseTo(1, 10);

    // The traced effective focal length must be the one the lens object itself reports, which is
    // what the ray diagram and the focal-point handles are drawn from.
    const height = 0.02;
    const { ray } = traceRay(surfaces, { x: 0, y: height, z: 0, dx: 0, dy: 0, dz: 1 });
    const traced = height / (-ray.dy / ray.dz);
    expect(traced).toBeCloseTo(lens.getFocalLength(), 2);
  });

  test('a lens is read the same way round as the light travels', () => {
    const scene = makeScene();
    // A plano-convex lens: flat face first, curved face second. The shape is set after the object
    // is made, because a radius of Infinity does not survive the scene file's JSON.
    const lens = new SphericalLens(scene, {
      name: 'Plano',
      defBy: 'DR1R2',
      p1: { x: 600, y: AXIS_Y - 40 },
      p2: { x: 600, y: AXIS_Y + 40 },
      params: { d: 12, r1: 300, r2: -150 },
      refIndex: 1.5,
    });
    scene.objs.push(lens);
    lens.createLensWithDR1R2(12, Infinity, -150);

    const { surfaces } = readPrescription(scene, AXIS_Y);
    expect(surfaces).toHaveLength(2);
    // The flat face is the one the light meets first, and the second radius is negative: the centre
    // of curvature of the rear face lies in front of it.
    expect(surfaces[0].radius).toBe(Infinity);
    expect(surfaces[1].radius).toBeLessThan(0);
  });

  test('an ideal lens images where the lens equation says', () => {
    const scene = makeScene();
    scene.objs.push(new IdealLens(scene, {
      name: 'Ideal',
      p1: { x: 600, y: AXIS_Y - 100 },
      p2: { x: 600, y: AXIS_Y + 100 },
      focalLength: 150,
    }));

    const { surfaces } = readPrescription(scene, AXIS_Y);
    const objectZ = 200;
    const paraxial = paraxialImage(surfaces, objectZ);

    // 1/v - 1/u = 1/f with u = -400.
    const v = 1 / (1 / 150 - 1 / 400);
    expect(paraxial.imageZ - 600).toBeCloseTo(v, 6);
    expect(paraxial.magnification).toBeCloseTo(-v / 400, 6);
  });

  test('elements outside the span between object and screen are left out', () => {
    const scene = makeScene();
    addLens(scene, { x: 400, halfAperture: 40, d: 10, f: 250, name: 'Before' });
    addLens(scene, { x: 800, halfAperture: 40, d: 10, f: 250, name: 'Between' });
    addLens(scene, { x: 1300, halfAperture: 40, d: 10, f: 250, name: 'After' });

    const { surfaces } = readPrescription(scene, AXIS_Y, { fromZ: 600, toZ: 1200 });
    expect(surfaces).toHaveLength(2);
    expect(surfaces.every(s => s.owner === 'Between')).toBe(true);
  });

  test('a lens off the axis is reported rather than traced', () => {
    const scene = makeScene();
    const lens = addLens(scene, { x: 600, halfAperture: 50, d: 12, f: 200, name: 'Tilted' });
    lens.move(0, 120);

    const { surfaces, warnings } = readPrescription(scene, AXIS_Y);
    expect(surfaces).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/not centred/);
  });

  test('the total power adds the lenses up', () => {
    const scene = makeScene();
    addLens(scene, { x: 600, halfAperture: 40, d: 10, f: 300, name: 'A' });
    addLens(scene, { x: 700, halfAperture: 40, d: 10, f: 600, name: 'B' });

    const all = totalLensPower(scene);
    const one = totalLensPower(scene, ['A']);
    expect(one).toBeCloseTo(1 / 300, 6);
    expect(all).toBeCloseTo(1 / 300 + 1 / 600, 6);
  });
});

describe('focal length and shape', () => {
  test('bending a lens leaves its focal length alone', () => {
    const scene = makeScene();
    const lens = new SphericalLens(scene, {
      name: 'Bendy',
      defBy: 'DFX',
      p1: { x: 600, y: AXIS_Y - 40 },
      p2: { x: 600, y: AXIS_Y + 40 },
      params: { d: 12, f: 220, x: 0 },
      refIndex: 1.5,
    });
    scene.objs.push(lens);

    for (const x of [-1.4, -1, -0.5, 0, 0.5, 1, 1.4]) {
      lens.createLensWithDFX(12, 220, x);
      expect(lens.path).toBeTruthy();
      expect(lens.getFocalLength()).toBeCloseTo(220, 3);
      expect(lens.getDFX().x).toBeCloseTo(x, 3);
    }
  });

  test('the named shapes are the shapes they are named after', () => {
    const scene = makeScene();
    const lens = new SphericalLens(scene, {
      name: 'Shapes',
      defBy: 'DFX',
      p1: { x: 600, y: AXIS_Y - 40 },
      p2: { x: 600, y: AXIS_Y + 40 },
      params: { d: 12, f: 260, x: 0 },
      refIndex: 1.5,
    });
    scene.objs.push(lens);

    lens.createLensWithDFX(12, 260, 0);
    let { r1, r2 } = lens.getDR1R2();
    expect(r1).toBeCloseTo(-r2, 3);

    lens.createLensWithDFX(12, 260, 1);
    ({ r1, r2 } = lens.getDR1R2());
    expect(Math.abs(r2)).toBeGreaterThan(1e6);
    expect(r1).toBeGreaterThan(0);

    lens.createLensWithDFX(12, 260, -1);
    ({ r1, r2 } = lens.getDR1R2());
    expect(Math.abs(r1)).toBeGreaterThan(1e6);
    expect(r2).toBeLessThan(0);
  });

  test('a strongly bent lens aberrates more than the best form at the same power', () => {
    const scene = makeScene();
    const lens = new SphericalLens(scene, {
      name: 'Singlet',
      defBy: 'DFX',
      p1: { x: 600, y: AXIS_Y - 45 },
      p2: { x: 600, y: AXIS_Y + 45 },
      params: { d: 20, f: 240, x: 0 },
      refIndex: 1.5,
    });
    scene.objs.push(lens);

    const objectZ = 0;
    const blur = (x) => {
      lens.createLensWithDFX(20, 240, x);
      const { surfaces } = readPrescription(scene, AXIS_Y);
      if (surfaces.length < 2) return Infinity;
      const paraxial = paraxialImage(surfaces, objectZ);
      if (!paraxial) return Infinity;
      const { ray } = traceRay(surfaces, {
        x: 0, y: 0, z: objectZ, ...normalizedDirection(0, 40, 600),
      });
      if (!ray) return Infinity;
      const t = (paraxial.imageZ - ray.z) / ray.dz;
      return Math.abs(ray.y + t * ray.dy);
    };

    // A meniscus bent well away from best form is much worse than a near-equiconvex lens.
    expect(blur(2.5)).toBeGreaterThan(blur(0.2));
  });
});

describe('the imaging screen', () => {
  test('reports its geometry and takes a picture', () => {
    const scene = makeScene();
    const screen = new ImageScreen(scene, {
      name: 'Screen',
      p1: { x: 1200, y: AXIS_Y - 70 },
      p2: { x: 1200, y: AXIS_Y + 70 },
    });
    scene.objs.push(screen);

    const geometry = screen.getGeometry();
    expect(geometry.z).toBeCloseTo(1200, 9);
    expect(geometry.halfHeight).toBeCloseTo(70, 9);
    expect(geometry.centre.y).toBeCloseTo(AXIS_Y, 9);

    expect(screen.picture).toBeNull();
    screen.setPicture('a canvas', { rms: 2.5 });
    expect(screen.diagnostics.rms).toBe(2.5);

    // The picture is derived from the rest of the scene, so it must not be written to the file.
    expect(JSON.stringify(screen.serialize())).not.toContain('a canvas');
  });
});
