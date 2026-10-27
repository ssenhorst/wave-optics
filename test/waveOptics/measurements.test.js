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

import Scene from '../../src/core/Scene.js';
import WaveScreen from '../../src/core/sceneObjs/wave/WaveScreen.js';
import WaveFocusProbe from '../../src/core/sceneObjs/wave/WaveFocusProbe.js';
import WavePlaneWave from '../../src/core/sceneObjs/wave/WavePlaneWave.js';
import WavePointSource from '../../src/core/sceneObjs/wave/WavePointSource.js';
import WaveMultiSlit from '../../src/core/sceneObjs/wave/WaveMultiSlit.js';
import WaveInterface from '../../src/core/sceneObjs/wave/WaveInterface.js';
import WaveRuler from '../../src/core/sceneObjs/wave/WaveRuler.js';
import { buildWaveModel } from '../../src/core/waveOptics/waveSceneModel.js';
import { computeFieldGrid } from '../../src/core/waveOptics/waveSceneModel.js';
import { computeModelFieldAt } from '../../src/core/waveOptics/WaveFieldEngineCpu.js';
import { peakInSubspace, fieldGrid } from '../../src/core/sceneObjs/wave/waveMeasurement.js';

const WAVELENGTH = 20;

function makeScene() {
  const scene = new Scene();
  scene.setViewportSize(1200, 800);
  scene.waveOptics.wavelength = WAVELENGTH;
  scene.waveOptics.sourceDensity = 8;
  return scene;
}

/**
 * Stand in for the simulator, which is what a measurement asks for the model
 * and for the samples. In the app those come from the GPU; here the same model
 * is built directly and the grid is filled on the CPU.
 */
function attachSimulator(scene, { withGrid = false, resolution = 128 } = {}) {
  const model = buildWaveModel(scene, { resolution });
  const simulator = { lastModel: model, fieldSerial: 1, fieldReadback: null };

  if (withGrid) {
    const { grid } = model;
    const points = [];
    for (let j = 0; j < grid.height; j++) {
      for (let i = 0; i < grid.width; i++) {
        points.push({
          x: grid.originX + grid.stepX * i,
          y: grid.originY + grid.stepY * j,
        });
      }
    }
    const field = computeModelFieldAt(model, points);
    const data = new Float32Array(points.length * 4);
    for (let i = 0; i < points.length; i++) {
      data[i * 4] = field[i * 2];
      data[i * 4 + 1] = field[i * 2 + 1];
      data[i * 4 + 2] = Math.hypot(field[i * 2], field[i * 2 + 1]);
      data[i * 4 + 3] = 1;
    }
    simulator.fieldReadback = data;
  }

  scene.simulator = simulator;
  return model;
}

function addPlaneWave(scene, x, y) {
  const wave = new WavePlaneWave(scene);
  Object.assign(wave, { x, y, angle: 0, amplitude: 1, phase: 0 });
  scene.objs.push(wave);
  return wave;
}

describe('wave ruler', () => {
  test('exposes and saves the wavelength-units toggle', () => {
    const scene = makeScene();
    const ruler = new WaveRuler(scene, {
      p1: { x: 100, y: 100 }, p2: { x: 300, y: 100 },
    });
    const createBoolean = jest.fn();

    ruler.populateObjBar({
      setTitle() {},
      createNumber() {},
      createBoolean,
    });

    const [, initialValue, setValue] = createBoolean.mock.calls[0];
    expect(initialValue).toBe(false);
    setValue(ruler, true);
    expect(ruler.serialize()).toMatchObject({
      type: 'WaveRuler', wavelengthUnits: true,
    });
  });

  test('draws on the layer above the field', () => {
    const scene = makeScene();
    const ruler = new WaveRuler(scene, {
      p1: { x: 100, y: 100 }, p2: { x: 300, y: 100 }, wavelengthUnits: true,
    });
    const ctx = {
      beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), stroke: jest.fn(),
      save: jest.fn(), restore: jest.fn(), translate: jest.fn(), rotate: jest.fn(),
      fillText: jest.fn(),
    };
    const renderer = { ctx, lengthScale: 1, rgbaToCssColor: () => 'gray' };

    ruler.draw(renderer, false, false);
    expect(ctx.beginPath).not.toHaveBeenCalled();

    ruler.draw(renderer, true, false);
    expect(ctx.beginPath).toHaveBeenCalled();
    expect(ctx.fillText.mock.calls.map(([label]) => label)).toEqual([
      '0 λ', '5 λ', '10 λ',
    ]);
  });
});

describe('screen', () => {
  test('takes no part in the optics', () => {
    const scene = makeScene();
    addPlaneWave(scene, 100, 400);
    const before = buildWaveModel(scene, { resolution: 64 });

    const screen = new WaveScreen(scene, {
      p1: { x: 600, y: 200 }, p2: { x: 600, y: 600 },
    });
    scene.objs.push(screen);
    const after = buildWaveModel(scene, { resolution: 64 });

    // Putting a detector into a scene must not change the scene.
    expect(after.interfaces).toHaveLength(before.interfaces.length);
    expect(after.diagnostics.sourceCount).toBe(before.diagnostics.sourceCount);
  });

  test('plots the intensity across a double slit as fringes', () => {
    const scene = makeScene();
    addPlaneWave(scene, 100, 400);
    const slits = new WaveMultiSlit(scene);
    slits.p1 = { x: 300, y: 100 };
    slits.p2 = { x: 300, y: 700 };
    Object.assign(slits, { slitCount: 2, slitWidth: 20, slitSpacing: 120 });
    scene.objs.push(slits);

    const screen = new WaveScreen(scene, {
      p1: { x: 1100, y: 100 }, p2: { x: 1100, y: 700 },
    });
    scene.objs.push(screen);
    attachSimulator(scene);

    const measurement = screen.measure();
    expect(measurement).not.toBeNull();
    expect(measurement.maxAmplitude).toBeGreaterThan(0);

    // Young's fringes: several maxima across the screen, not one lobe.
    const { amplitudes } = measurement;
    let maxima = 0;
    for (let i = 1; i < amplitudes.length - 1; i++) {
      if (amplitudes[i] > amplitudes[i - 1] && amplitudes[i] > amplitudes[i + 1] &&
        amplitudes[i] > 0.15 * measurement.maxAmplitude) maxima++;
    }
    expect(maxima).toBeGreaterThan(2);
  }, 30000);

  test('the far field puts double-slit orders at sin(theta) = m lambda / d', () => {
    const spacing = 120;
    const scene = makeScene();
    addPlaneWave(scene, 100, 400);
    const slits = new WaveMultiSlit(scene);
    slits.p1 = { x: 300, y: 100 };
    slits.p2 = { x: 300, y: 700 };
    Object.assign(slits, { slitCount: 2, slitWidth: 20, slitSpacing: spacing });
    scene.objs.push(slits);

    const screen = new WaveScreen(scene, {
      p1: { x: 1100, y: 100 }, p2: { x: 1100, y: 700 }, farField: true,
    });
    scene.objs.push(screen);
    attachSimulator(scene);

    const measurement = screen.measure();
    expect(measurement).not.toBeNull();
    const { layout, amplitudes } = measurement;

    // The angles the endpoints subtend at the centre of the last surface.
    expect(layout.isAngular).toBe(true);
    expect(layout.axis[0]).toBeCloseTo(
      Math.atan2(100 - 400, 1100 - 300) * 180 / Math.PI, 6
    );

    const peakAngles = [];
    for (let i = 1; i < amplitudes.length - 1; i++) {
      if (amplitudes[i] > amplitudes[i - 1] && amplitudes[i] > amplitudes[i + 1] &&
        amplitudes[i] > 0.2 * measurement.maxAmplitude) {
        peakAngles.push(layout.axis[i]);
      }
    }
    expect(peakAngles.length).toBeGreaterThan(2);

    // Every peak found must sit on an order of the grating, to within the
    // angular step the screen samples at.
    const step = Math.abs(layout.axis[1] - layout.axis[0]);
    for (const degrees of peakAngles) {
      const order = Math.sin(degrees * Math.PI / 180) * spacing / WAVELENGTH;
      expect(Math.abs(order - Math.round(order))).toBeLessThan(0.2);
    }
    // And the orders that fall inside the range must all be there.
    expect(peakAngles.length).toBeGreaterThanOrEqual(3);
    expect(step).toBeGreaterThan(0);
  }, 30000);

  test('the far-field angular range is measured from its vertex', () => {
    const scene = makeScene();
    const screen = new WaveScreen(scene, {
      p1: { x: 1100, y: 100 },
      p2: { x: 1100, y: 700 },
      p3: { x: 500, y: 400 },
      farField: true,
    });

    const layout = screen.samplePoints();
    expect(layout.axis[0]).toBeCloseTo(
      Math.atan2(100 - 400, 1100 - 500) * 180 / Math.PI, 6
    );
    expect(screen.farFieldOrigin()).toMatchObject({ x: 500, y: 400 });

    screen.p3 = { x: 1100, y: 100 };
    expect(screen.samplePoints()).toBeNull();
  });

  test('sampleCount sets how many points the plot has, clamped to a sane range', () => {
    const scene = makeScene();
    addPlaneWave(scene, 100, 400);
    const screen = new WaveScreen(scene, {
      p1: { x: 900, y: 100 }, p2: { x: 900, y: 700 }, sampleCount: 33,
    });
    scene.objs.push(screen);
    attachSimulator(scene);

    expect(screen.measure().amplitudes.length).toBe(33);

    // Out-of-range values degrade to the clamp rather than to garbage.
    screen.sampleCount = 3;
    expect(screen.samples()).toBeGreaterThanOrEqual(17);
    screen.sampleCount = 1e9;
    expect(screen.samples()).toBeLessThanOrEqual(2049);
  }, 15000);

  test('always shows the plot when alwaysShowPlot is set, without being selected', () => {
    const scene = makeScene();
    addPlaneWave(scene, 100, 400);
    const screen = new WaveScreen(scene, {
      p1: { x: 900, y: 100 }, p2: { x: 900, y: 700 }, alwaysShowPlot: true,
    });
    scene.objs.push(screen);
    attachSimulator(scene);

    let plotDrawn = false;
    const originalDrawPlot = screen.drawPlot.bind(screen);
    screen.drawPlot = (...args) => { plotDrawn = true; return originalDrawPlot(...args); };

    // isSelected() reads scene.editor, which is absent in this headless setup,
    // so this exercises exactly the "not selected" path.
    expect(screen.isSelected()).toBe(false);
    screen.draw({ ctx: { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, arc() {}, setLineDash() {}, fillText() {}, strokeText() {} }, lengthScale: 1 }, true, false);
    expect(plotDrawn).toBe(true);
  }, 15000);

  test('the far field is the same shape wherever the screen is put', () => {
    const build = (x) => {
      const scene = makeScene();
      addPlaneWave(scene, 100, 400);
      const slits = new WaveMultiSlit(scene);
      slits.p1 = { x: 300, y: 100 };
      slits.p2 = { x: 300, y: 700 };
      Object.assign(slits, { slitCount: 2, slitWidth: 20, slitSpacing: 120 });
      scene.objs.push(slits);
      // Same angular span, different distance: the pattern at infinity cannot
      // depend on where the screen showing it happens to sit.
      const half = (x - 300) * Math.tan(20 * Math.PI / 180);
      const screen = new WaveScreen(scene, {
        p1: { x, y: 400 - half }, p2: { x, y: 400 + half }, farField: true,
      });
      scene.objs.push(screen);
      attachSimulator(scene);
      return screen.measure();
    };

    const near = build(800);
    const far = build(2000);
    for (let i = 0; i < near.amplitudes.length; i += 16) {
      expect(near.amplitudes[i] / near.maxAmplitude)
        .toBeCloseTo(far.amplitudes[i] / far.maxAmplitude, 3);
    }
  }, 30000);
});

describe('focus probe', () => {
  test('searches only the subspace it was dropped into', () => {
    const scene = makeScene();
    addPlaneWave(scene, 100, 400);
    const surface = new WaveInterface(scene, {
      p1: { x: 600, y: -400 }, p2: { x: 600, y: 1200 }, refractiveIndexAfter: 1,
      eqnAmplitude: '0.2',
    });
    scene.objs.push(surface);

    const before = new WaveFocusProbe(scene, { x: 300, y: 400 });
    const after = new WaveFocusProbe(scene, { x: 900, y: 400 });
    scene.objs.push(before, after);
    attachSimulator(scene, { withGrid: true, resolution: 96 });

    const first = before.measure();
    const second = after.measure();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    // Each probe's maximum lies on its own side of the surface...
    expect(first.x).toBeLessThan(600);
    expect(second.x).toBeGreaterThan(600);
    // ...and the attenuating surface makes the second one dimmer, which is the
    // point of confining the search: the global maximum is on the near side.
    expect(second.amplitude).toBeLessThan(first.amplitude);
  }, 30000);

  test('measures the width of a peak at half its intensity', () => {
    // A synthetic field, so the answer is known exactly rather than argued
    // from optics: a Gaussian of known width has FWHM = 2 sqrt(2 ln 2) sigma.
    const scene = makeScene();
    const grid = computeFieldGrid(scene, 256);
    const sigma = 40;
    const data = new Float32Array(grid.width * grid.height * 4);
    for (let j = 0; j < grid.height; j++) {
      const y = grid.originY + grid.stepY * j;
      for (let i = 0; i < grid.width; i++) {
        const x = grid.originX + grid.stepX * i;
        const amplitude = Math.exp(
          -((x - 600) ** 2 + (y - 400) ** 2) / (2 * sigma * sigma)
        );
        data[(j * grid.width + i) * 4 + 2] = amplitude;
      }
    }

    const peak = peakInSubspace({ data, grid, interfaces: [] }, 0);
    expect(peak.x).toBeCloseTo(600, -1);
    expect(peak.y).toBeCloseTo(400, -1);

    // The amplitude is the Gaussian, so the intensity has sigma/sqrt(2).
    const expected = 2 * Math.sqrt(2 * Math.log(2)) * sigma / Math.sqrt(2);
    expect(peak.width / expected).toBeGreaterThan(0.95);
    expect(peak.width / expected).toBeLessThan(1.05);
  });

  test('ignores a source it sits on top of, in favour of a real maximum nearby', () => {
    // A synthetic field standing in for the physical situation: an enormous
    // spike at a source's own location (the near-source clamp still leaves it
    // far brighter than anything a real focus produces) and a much smaller,
    // broad maximum representing genuine interference structure elsewhere.
    // Without exclusion the search finds the spike; the point of it is to find
    // the other one instead.
    const scene = makeScene();
    const grid = computeFieldGrid(scene, 128);
    const source = { x: 600, y: 400 };
    const realFocus = { x: 850, y: 500 };
    const data = new Float32Array(grid.width * grid.height * 4);

    let sourceCell = -1;
    let bestSourceDist = Infinity;
    for (let j = 0; j < grid.height; j++) {
      const y = grid.originY + grid.stepY * j;
      for (let i = 0; i < grid.width; i++) {
        const x = grid.originX + grid.stepX * i;
        const cell = j * grid.width + i;
        const distToSource = Math.hypot(x - source.x, y - source.y);
        if (distToSource < bestSourceDist) { bestSourceDist = distToSource; sourceCell = cell; }
        data[cell * 4 + 2] = Math.exp(
          -((x - realFocus.x) ** 2 + (y - realFocus.y) ** 2) / (2 * 30 * 30)
        );
      }
    }
    data[sourceCell * 4 + 2] = 1e6;

    const field = { data, grid, interfaces: [] };

    // Sanity check: unexcluded, the search really does find the spike.
    const unexcluded = peakInSubspace(field, 0);
    expect(unexcluded.amplitude).toBeCloseTo(1e6, 0);

    field.excludePointsBySubspace = [[source]];
    field.excludeRadiusBySubspace = [3 * WAVELENGTH];
    const excluded = peakInSubspace(field, 0);

    expect(excluded.amplitude).toBeLessThan(2);
    expect(Math.hypot(excluded.x - realFocus.x, excluded.y - realFocus.y))
      .toBeLessThan(grid.spacing * 3);
    expect(Math.hypot(excluded.x - source.x, excluded.y - source.y))
      .toBeGreaterThanOrEqual(3 * WAVELENGTH);
  });

  test('ignores the radiating surface itself, and follows it when it is tilted', () => {
    // The other half of the same problem: the secondary sources that carry the
    // field across an interface sit *on* that interface, so a sample landing on
    // one sees the clamped kernel at zero range. The band skipped around the
    // surface has to follow it when it is tilted, or a steep surface leaves a
    // sliver of its own sites in the search.
    const scene = makeScene();
    const grid = computeFieldGrid(scene, 128);
    const slope = 0.8;
    const surfaceAt = (y) => 600 + slope * (y - 400);
    const surface = {
      zAt: surfaceAt,
      getExtent: () => ({ yMin: -1000, yMax: 2000 }),
      meanZ: () => 600,
    };

    const realFocus = { x: 950, y: 400 };
    const data = new Float32Array(grid.width * grid.height * 4);
    for (let j = 0; j < grid.height; j++) {
      const y = grid.originY + grid.stepY * j;
      for (let i = 0; i < grid.width; i++) {
        const x = grid.originX + grid.stepX * i;
        // A huge ridge along the surface, standing in for its sample sites,
        // plus a modest genuine focus well downstream of it.
        const perpendicular = Math.abs(x - surfaceAt(y)) / Math.hypot(1, slope);
        data[(j * grid.width + i) * 4 + 2] = perpendicular < 0.6 * WAVELENGTH
          ? 1e4
          : Math.exp(-((x - realFocus.x) ** 2 + (y - realFocus.y) ** 2) / (2 * 40 * 40));
      }
    }

    const field = {
      data, grid, interfaces: [surface], axisSign: 1,
      excludePointsBySubspace: [[], []],
      excludeRadiusBySubspace: [WAVELENGTH, WAVELENGTH],
    };

    // Subspace 1 is the one the surface radiates into.
    const peak = peakInSubspace(field, 1);
    expect(peak.amplitude).toBeLessThan(2);
    expect(Math.hypot(peak.x - realFocus.x, peak.y - realFocus.y))
      .toBeLessThan(grid.spacing * 3);
  });

  test('excludes the field engine\'s own point sources from fieldGrid', () => {
    // End-to-end version of the same thing: two point sources close enough
    // together that a probe between them shares their subspace, the case the
    // per-subspace confinement alone does not protect against.
    const scene = makeScene();
    const a = new WavePointSource(scene, { x: 550, y: 380, amplitude: 1, phase: 0 });
    const b = new WavePointSource(scene, { x: 650, y: 420, amplitude: 1, phase: 0 });
    scene.objs.push(a, b);
    const probe = new WaveFocusProbe(scene, { x: 600, y: 400 });
    scene.objs.push(probe);
    const model = attachSimulator(scene, { withGrid: true, resolution: 256 });

    const field = fieldGrid(scene);
    expect(field.excludePointsBySubspace[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 550, y: 380 }),
        expect.objectContaining({ x: 650, y: 420 }),
      ])
    );

    const result = probe.measure();
    expect(result).not.toBeNull();
    for (const source of [a, b]) {
      expect(Math.hypot(result.x - source.x, result.y - source.y))
        .toBeGreaterThanOrEqual(model.settings.wavelength - 1e-6);
    }
  }, 30000);
});
