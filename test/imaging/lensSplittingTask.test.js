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
 * @file Checks that the `lens_splitting` assignment is actually solvable, and that it is not
 * solvable the wrong way.
 *
 * The numbers in a task scene are a claim about physics: that the state it opens in fails, that the
 * intended solution passes, and that the obvious shortcut does not. None of the three is obvious
 * from the file, and all three move if anything in the trace changes, so they are asserted here.
 */

import fs from 'fs';
import path from 'path';
import Scene from '../../src/core/Scene.js';
import { GOAL_TYPES } from '../../src/core/goals/TaskEvaluator.js';
import { validateTask } from '../../src/core/goals/TaskEvaluator.js';
import { validateIllustration } from '../../src/core/illustration.js';
import { readPrescription } from '../../src/core/imaging/prescription.js';
import { traceSpotField } from '../../src/core/imaging/screenRenderer.js';

const SCENE_PATH = path.join(__dirname, '../../data/taskScenes/lens_splitting.json');

/**
 * Load the assignment into a scene.
 * @returns {{scene: Scene, task: Object}} The scene and its task.
 */
function loadScene() {
  const json = fs.readFileSync(SCENE_PATH, 'utf8');
  const scene = new Scene();
  scene.setViewportSize(1700, 900);
  scene.loadJSON(json, () => {});
  expect(scene.error).toBeFalsy();
  return { scene, task: scene.task };
}

/**
 * The shape of the object, taken from the scene the same way the renderer takes it.
 * @param {Scene} scene - The scene.
 * @returns {{z: number, halfHeight: number, radius: number}} The object.
 */
function objectOf(scene) {
  const tip = scene.objs.find(o => o.name === 'Tip');
  const base = scene.objs.find(o => o.name === 'Base');
  const halfHeight = Math.abs(tip.p1.y - base.p1.y) / 2;
  // The apple picture is 600 x 620, so it is very slightly narrower than it is tall.
  const halfWidth = halfHeight * 600 / 620;
  return { z: tip.p1.x, halfHeight, radius: Math.hypot(halfWidth, halfHeight) };
}

/**
 * Trace the system as it stands and fill in the diagnostics the goals read, exactly as the
 * controller does in the browser.
 * @param {Scene} scene - The scene.
 * @returns {Object} The diagnostics.
 */
function measure(scene) {
  const screen = scene.objs.find(o => o.constructor.type === 'ImageScreen');
  const geometry = screen.getGeometry();
  const object = objectOf(scene);

  const { surfaces, warnings } = readPrescription(scene, geometry.centre.y, {
    fromZ: object.z, toZ: geometry.z,
  });
  expect(warnings).toEqual([]);

  const field = traceSpotField({
    surfaces, objectZ: object.z, objectRadius: object.radius, screenZ: geometry.z,
    ambientIndex: 1, fieldSamples: 10, pupilSamples: 300,
  });
  expect(field).toBeTruthy();

  const imageRadius = Math.abs(field.spots[field.spots.length - 1].centroid);
  const diagnostics = {
    rms: field.rms,
    objectRadius: object.radius,
    imageRadius,
    imageMagnification: imageRadius / object.radius,
  };
  screen.setPicture(null, diagnostics);
  return diagnostics;
}

/**
 * Score one goal of the task.
 * @param {Scene} scene - The scene.
 * @param {string} id - The goal's id.
 * @returns {Object} The result.
 */
function score(scene, id) {
  const goal = scene.task.goals.find(g => g.id === id);
  return GOAL_TYPES[goal.type].evaluate(goal, { scene });
}

/**
 * Put the screen where the picture comes out the size the task asks for.
 * @param {Scene} scene - The scene.
 * @returns {number} Where the screen was put.
 */
function frameTheScreen(scene) {
  const screen = scene.objs.find(o => o.constructor.type === 'ImageScreen');
  const target = scene.task.goals.find(g => g.id === 'framing').target;

  // A coarse sweep followed by a fine one around the winner: the magnification varies smoothly
  // with the screen position, so there is nothing for a dense scan to find.
  let best = null;
  const sweep = (from, to, step) => {
    for (let z = from; z <= to; z += step) {
      screen.move(z - screen.p1.x, 0);
      const miss = Math.abs(measure(scene).imageMagnification - target);
      if (!best || miss < best.miss) best = { miss, z };
    }
  };
  sweep(1150, 1750, 10);
  sweep(best.z - 10, best.z + 10, 1);
  screen.move(best.z - screen.p1.x, 0);
  measure(scene);
  return best.z;
}

describe('the lens-splitting assignment', () => {
  test('the scene file is valid', () => {
    const { scene, task } = loadScene();
    expect(validateTask(task)).toBeNull();
    expect(validateIllustration(scene.illustration)).toBeNull();
    expect(scene.objs.map(o => o.name)).toEqual(
      ['Tip', 'Base', 'Lens 1', 'Lens 2', 'Lens 3', 'Screen']
    );
    // Every lens must have been buildable from the parameters the file gives.
    for (const lens of scene.objs.filter(o => o.constructor.type === 'SphericalLens')) {
      expect(lens.path).toBeTruthy();
      expect(lens.error).toBeFalsy();
    }
  });

  test('it opens correctly framed, correctly powered and badly blurred', () => {
    const { scene } = loadScene();
    measure(scene);

    expect(score(scene, 'power').satisfied).toBe(true);
    expect(score(scene, 'framing').satisfied).toBe(true);

    const sharp = score(scene, 'sharp');
    expect(sharp.satisfied).toBe(false);
    // Badly enough that the blur is obvious next to an apple only 117 units across.
    const screen = scene.objs.find(o => o.name === 'Screen');
    expect(screen.diagnostics.rms).toBeGreaterThan(8);

    // And the progress bar must still be off the floor, so the student can see it respond.
    expect(sharp.progress).toBeGreaterThan(0.1);
    expect(sharp.progress).toBeLessThan(0.6);
  });

  test('sharing the power between the three lenses solves it', () => {
    const { scene } = loadScene();
    const total = scene.task.goals.find(g => g.id === 'power').target;

    // The intended answer: three equal shares of the same total power.
    for (const name of ['Lens 1', 'Lens 2', 'Lens 3']) {
      scene.objs.find(o => o.name === name).focalLength = 3 / total;
    }
    frameTheScreen(scene);

    for (const id of ['power', 'framing', 'sharp']) {
      expect([id, score(scene, id).satisfied]).toEqual([id, true]);
    }
  });

  test('splitting the power is what fixes it, and two lenses already do', () => {
    const blurWith = (shares) => {
      const { scene } = loadScene();
      const total = scene.task.goals.find(g => g.id === 'power').target;
      const names = ['Lens 1', 'Lens 2', 'Lens 3'];
      shares.forEach((share, i) => {
        // A share of 0 means a lens left with no appreciable power at all.
        scene.objs.find(o => o.name === names[i]).focalLength =
          share > 0 ? 1 / (total * share) : 1e6;
      });
      frameTheScreen(scene);
      return scene.objs.find(o => o.name === 'Screen').diagnostics.rms;
    };

    const threshold = sharpnessThreshold();
    const one = blurWith([0, 1, 0]);
    // Either pair works. The outer pair is the better of the two, because spreading the two
    // elements apart is itself worth something.
    const twoOuter = blurWith([0.5, 0, 0.5]);
    const twoAdjacent = blurWith([0, 0.5, 0.5]);
    const three = blurWith([1 / 3, 1 / 3, 1 / 3]);

    // One lens is hopeless, and sharing the work is what rescues it rather than anything else.
    expect(one).toBeGreaterThan(2 * threshold);
    expect(twoOuter).toBeLessThan(one / 4);

    // Every way of sharing the power passes, so the student is not hunting for one exact answer.
    expect(twoOuter).toBeLessThan(twoAdjacent);
    for (const blur of [twoOuter, twoAdjacent, three]) {
      expect(blur).toBeLessThan(threshold);
    }

    // Three elements are not dramatically better than two here, because the extra elements
    // lengthen the system; the lesson is the first split, not a race to add elements.
    expect(Math.abs(three - twoOuter)).toBeLessThan(threshold / 2);
  });

  test('sliding the screen to the tightest blur is rejected for being too small', () => {
    const { scene } = loadScene();
    const screen = scene.objs.find(o => o.constructor.type === 'ImageScreen');

    // The circle of least confusion of the single strong lens, found by sliding the screen only.
    let best = null;
    for (let z = 1200; z <= 1600; z += 8) {
      screen.move(z - screen.p1.x, 0);
      const measured = measure(scene);
      if (!best || measured.rms < best.rms) best = { ...measured, z };
    }
    screen.move(best.z - screen.p1.x, 0);
    measure(scene);

    // It is a real improvement — which is why the exercise has to rule it out explicitly.
    expect(best.rms).toBeLessThan(8);
    expect(score(scene, 'framing').satisfied).toBe(false);
    expect(best.imageMagnification).toBeLessThan(1.3);
  });
});

/**
 * The blur the task calls sharp enough.
 * @returns {number} The threshold.
 */
function sharpnessThreshold() {
  const json = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  return json.task.goals.find(g => g.id === 'sharp').max;
}
