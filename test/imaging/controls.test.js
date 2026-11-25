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
 * @file Checks the always-visible control panel: that a scene's sliders really address properties
 * its objects have, and that the meters read what they claim to.
 *
 * A slider naming a property that does not exist is the worst kind of mistake to make here, because
 * it looks perfectly fine — the panel draws, the handle moves, and nothing happens.
 */

import fs from 'fs';
import path from 'path';
import Scene from '../../src/core/Scene.js';
import SphericalLens from '../../src/core/sceneObjs/glass/SphericalLens.js';
import ImageScreen from '../../src/core/sceneObjs/other/ImageScreen.js';
import { validateControls, readMeter } from '../../src/core/controls.js';
import { totalLensPower } from '../../src/core/imaging/prescription.js';
import { getByKeyPath } from '../../src/core/propertyUtils/keyPath.js';

const SCENE_PATH = path.join(__dirname, '../../data/taskScenes/lens_splitting.json');

describe('validating a controls block', () => {
  test('a minimal panel is accepted', () => {
    expect(validateControls(null)).toBeNull();
    expect(validateControls({
      title: 'Lenses',
      groups: [{ object: 'Lens', sliders: [{ property: 'power', min: 0, max: 4 }] }],
    })).toBeNull();
  });

  test('unknown keys and malformed sliders are reported', () => {
    expect(validateControls({ nope: 1 })).toMatch(/unknown controls key/);
    expect(validateControls({ groups: [{ sliders: [] }] })).toMatch(/requires 'object'/);
    expect(validateControls({ groups: [{ object: 'L', sliders: [] }] })).toMatch(/non-empty/);
    expect(validateControls({
      groups: [{ object: 'L', sliders: [{ min: 0, max: 1 }] }],
    })).toMatch(/requires 'property'/);
    expect(validateControls({
      groups: [{ object: 'L', sliders: [{ property: 'power', min: 4, max: 0 }] }],
    })).toMatch(/above 'min'/);
    expect(validateControls({ meters: [{ source: 'vibes' }] })).toMatch(/unknown source/);
  });
});

describe('the lens-splitting panel', () => {
  const scene = new Scene();
  beforeAll(() => {
    scene.setViewportSize(1700, 900);
    scene.loadJSON(fs.readFileSync(SCENE_PATH, 'utf8'), () => {});
    expect(scene.error).toBeFalsy();
  });

  test('every slider addresses a property its object really has', () => {
    for (const group of scene.controls.groups) {
      const obj = scene.objs.find(o => o.name === group.object);
      expect([group.object, !!obj]).toEqual([group.object, true]);

      for (const slider of group.sliders) {
        const value = getByKeyPath(obj, slider.property);
        expect([group.object, slider.property, typeof value])
          .toEqual([group.object, slider.property, 'number']);

        // And it must be writable, or the slider would move and change nothing.
        const original = value;
        const probe = (slider.min + slider.max) / 2;
        obj[slider.property] = probe;
        expect(getByKeyPath(obj, slider.property)).toBeCloseTo(probe, 2);
        obj[slider.property] = original;
      }
    }
  });

  test('the sliders can reach the answer the task asks for', () => {
    const powerSlider = scene.controls.groups[0].sliders
      .find(s => s.property === 'power');
    // A third of the total power must be somewhere on the slider, or the task is unsolvable with
    // the controls the scene provides.
    const share = 3.4286 / 3;
    expect(share).toBeGreaterThanOrEqual(powerSlider.min);
    expect(share).toBeLessThanOrEqual(powerSlider.max);
  });

  test('every slider the scene shows is one the interaction settings allow', () => {
    for (const group of scene.controls.groups) {
      const obj = scene.objs.find(o => o.name === group.object);
      for (const slider of group.sliders) {
        expect([group.object, slider.property, obj.interaction?.properties?.[slider.property]])
          .toEqual([group.object, slider.property, true]);
      }
    }
  });

  test('the power meter reads the lenses in the units the label promises', () => {
    const meter = scene.controls.meters.find(m => m.source === 'lensPowerSum');
    const reading = readMeter(meter, scene, totalLensPower);
    expect(reading.value).toBeCloseTo(3.43, 1);
    expect(reading.onTarget).toBe(true);
    expect(reading.text).toBe('3.43');
  });

  test('a meter with nothing measured yet reads blank rather than zero', () => {
    const meter = scene.controls.meters.find(m => m.source === 'maxIncidence');
    const reading = readMeter(meter, scene, totalLensPower);
    expect(reading.value).toBeNull();
    expect(reading.text).toBe('—');
  });

  test('a meter where less is better fills up as the value falls', () => {
    const screen = scene.objs.find(o => o.constructor.type === 'ImageScreen');
    const meter = scene.controls.meters.find(m => m.source === 'maxIncidence');

    screen.setPicture(null, { maxIncidence: meter.max });
    expect(readMeter(meter, scene, totalLensPower).fraction).toBeCloseTo(0, 5);

    screen.setPicture(null, { maxIncidence: meter.min });
    expect(readMeter(meter, scene, totalLensPower).fraction).toBeCloseTo(1, 5);
  });
});

describe('power as a property of a lens', () => {
  test('it is the reciprocal of the focal length, scaled', () => {
    const scene = new Scene();
    scene.setViewportSize(1600, 800);
    const lens = new SphericalLens(scene, {
      name: 'L', defBy: 'DFX',
      p1: { x: 600, y: 360 }, p2: { x: 600, y: 440 },
      params: { d: 12, f: 250, x: 0 }, refIndex: 1.5,
    });
    scene.objs.push(lens);

    expect(lens.power).toBeCloseTo(1000 / 250, 3);

    lens.power = 2.5;
    expect(lens.getDFX().f).toBeCloseTo(400, 2);
    expect(lens.power).toBeCloseTo(2.5, 3);
  });

  test('powers add up where focal lengths do not', () => {
    const scene = new Scene();
    scene.setViewportSize(1600, 800);
    for (const [name, f] of [['A', 300], ['B', 600]]) {
      scene.objs.push(new SphericalLens(scene, {
        name, defBy: 'DFX',
        p1: { x: 600, y: 370 }, p2: { x: 600, y: 430 },
        params: { d: 10, f, x: 0 }, refIndex: 1.5,
      }));
    }
    const [a, b] = scene.objs;
    expect(a.power + b.power).toBeCloseTo(totalLensPower(scene) * 1000, 3);
  });

  test('a lens can be turned down to no power at all without breaking', () => {
    const scene = new Scene();
    scene.setViewportSize(1600, 800);
    const lens = new SphericalLens(scene, {
      name: 'L', defBy: 'DFX',
      p1: { x: 600, y: 360 }, p2: { x: 600, y: 440 },
      params: { d: 10, f: 250, x: 0 }, refIndex: 1.5,
    });
    scene.objs.push(lens);

    // Sliding the power to zero must leave a flat plate, not an unbuildable lens: a slider whose
    // end of travel breaks the scene is a slider a student will find within a minute.
    for (const power of [1, 0.5, 0.1, 0.02, 0, 0.02, 0.5]) {
      lens.power = power;
      expect([power, !!lens.path]).toEqual([power, true]);
      expect([power, lens.error]).toEqual([power, null]);
    }
  });
});

describe('the screen', () => {
  test('a target outline is only drawn when the scene asks for one', () => {
    const scene = new Scene();
    scene.setViewportSize(1600, 800);
    const plain = new ImageScreen(scene, {
      name: 'S', p1: { x: 100, y: 300 }, p2: { x: 100, y: 500 },
    });
    expect(plain.targetMagnification).toBe(0);
    expect(plain.targetBox).toBeNull();
  });
});
