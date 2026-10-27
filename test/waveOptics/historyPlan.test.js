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
 * The bookkeeping behind the streaming time-domain engine.
 *
 * Besides the window arithmetic on its own, this runs the GPU algorithm in
 * JavaScript — ring-buffered histories, filled interface by interface and read
 * back with linear interpolation, exactly as the shaders do — and checks it
 * against the direct recursion of the reference engine. That is what shows the
 * window is long enough for light that has crossed more than one interface.
 */

import Scene from '../../src/core/Scene.js';
import WavePointSource from '../../src/core/sceneObjs/wave/WavePointSource.js';
import WaveInterface from '../../src/core/sceneObjs/wave/WaveInterface.js';
import WaveScreen from '../../src/core/sceneObjs/wave/WaveScreen.js';
import { buildWaveModel, subspaceIndexAt } from '../../src/core/waveOptics/waveSceneModel.js';
import { computeModelFieldAtTime } from '../../src/core/waveOptics/WaveFieldEngineCpu.js';
import { greensFunction, rayleighSommerfeldKernel } from '../../src/core/waveOptics/hankel.js';
import { wavenumber, minimumRadius } from '../../src/core/waveOptics/conventions.js';
import { signalEnvelope } from '../../src/core/waveOptics/signals.js';
import {
  planHistory, advanceHistory, slotRanges, slotOf, historyShape, viewDelay, chainDelay,
  HISTORY_STEPS_PER_DURATION, HISTORY_MARGIN_SLOTS,
  averagingTimes, sceneTimeSpan, AVERAGE_SAMPLES_PER_DURATION,
  NOISE_AVERAGE_COHERENCE_TIMES, MAX_AVERAGE_SAMPLES,
} from '../../src/core/waveOptics/timeDomain.js';

const WAVELENGTH = 20;

describe('ring-buffer arithmetic', () => {
  test('a step maps to its column modulo the slot count', () => {
    expect(slotOf(0, 8)).toBe(0);
    expect(slotOf(13, 8)).toBe(5);
  });

  test('a range of steps splits where it wraps', () => {
    expect(slotRanges(5, 7, 8)).toEqual([{ start: 5, count: 3 }]);
    expect(slotRanges(6, 9, 8)).toEqual([{ start: 6, count: 2 }, { start: 0, count: 2 }]);
    expect(slotRanges(3, 2, 8)).toEqual([]);
    expect(slotRanges(0, 40, 8)).toEqual([{ start: 0, count: 8 }]);
  });

  test('a history taller than a texture splits into side-by-side blocks', () => {
    expect(historyShape(10000, 100, 4096)).toEqual({ rows: 4096, blocks: 3, width: 300, height: 4096 });
    expect(historyShape(0, 100, 4096)).toEqual({ rows: 1, blocks: 1, width: 100, height: 1 });
  });
});

describe('advancing the clock', () => {
  const plan = { step: 0.5, slots: 100, neededSlots: 80 };

  test('starts with a full window whose newest step is at or just after the time', () => {
    const move = advanceHistory(null, 12.3, plan);
    expect(move.refill).toBe(true);
    expect(move.newest).toBe(99);
    const newestTime = move.epoch + move.newest * plan.step;
    expect(newestTime).toBeGreaterThanOrEqual(12.3);
    expect(newestTime - 12.3).toBeLessThan(plan.step);
  });

  test('a small step forward fills only the steps passed', () => {
    const first = advanceHistory(null, 10, plan);
    const move = advanceHistory(first, 11.2, plan);
    expect(move.refill).toBe(false);
    expect(move.from).toBe(first.newest + 1);
    expect(move.newest - first.newest).toBe(3);
    expect(move.epoch).toBe(first.epoch);
  });

  test('standing still fills nothing', () => {
    const first = advanceHistory(null, 10, plan);
    const move = advanceHistory(first, 10, plan);
    expect(move.refill).toBe(false);
    expect(move.from).toBeGreaterThan(move.newest);
  });

  test('a jump longer than the window refills it', () => {
    const first = advanceHistory(null, 10, plan);
    expect(advanceHistory(first, 10 + plan.slots * plan.step, plan).refill).toBe(true);
  });

  test('a small scrub back is served from the spare steps, a larger one refills', () => {
    const first = advanceHistory(null, 10, plan);
    const small = advanceHistory(first, 10 - 5 * plan.step, plan);
    expect(small.refill).toBe(false);
    expect(small.from).toBeGreaterThan(small.newest);
    expect(advanceHistory(first, 10 - 30 * plan.step, plan).refill).toBe(true);
  });
});

function makeScene() {
  const scene = new Scene();
  scene.waveOptics.wavelength = WAVELENGTH;
  scene.waveOptics.refractiveIndex = 1;
  return scene;
}

function addInterface(scene, x, half, indexAfter) {
  const surface = new WaveInterface(scene);
  surface.p1 = { x, y: -half };
  surface.p2 = { x, y: half };
  surface.refractiveIndexAfter = indexAfter;
  scene.objs.push(surface);
}

/**
 * A pulse into a short glass slab: two interfaces, three subspaces. Kept small,
 * and the pulse long, because the emulator below evaluates every site against
 * every site at every step in JavaScript.
 */
function slabModel({ duration = 12 } = {}) {
  const scene = makeScene();
  const source = new WavePointSource(scene);
  Object.assign(source, {
    x: -200, y: 0, amplitude: 1, signalType: 'pulse', signalDelay: 0, signalDuration: duration,
  });
  scene.objs.push(source);
  addInterface(scene, 0, 80, 1.5);
  addInterface(scene, 120, 80, 1);
  return buildWaveModel(scene, { resolution: 64 });
}

/**
 * Glass across most of the view, so the light reaching the far edge has spent
 * most of its delay on the way between the two interfaces. That is the case in
 * which the window has to add the chain delay to the view delay.
 */
function wideSlabModel() {
  const scene = makeScene();
  const source = new WavePointSource(scene);
  Object.assign(source, {
    x: -200, y: 400, amplitude: 1, signalType: 'pulse', signalDelay: 0, signalDuration: 12,
  });
  scene.objs.push(source);
  const left = new WaveInterface(scene);
  left.p1 = { x: 0, y: 320 };
  left.p2 = { x: 0, y: 480 };
  left.refractiveIndexAfter = 1.5;
  const right = new WaveInterface(scene);
  right.p1 = { x: 1400, y: 320 };
  right.p2 = { x: 1400, y: 480 };
  right.refractiveIndexAfter = 1;
  scene.objs.push(left, right);
  return buildWaveModel(scene, { resolution: 64 });
}

describe('planning the histories', () => {
  test('steps a sixth of the shortest signal duration', () => {
    const plan = planHistory(slabModel({ duration: 6 }));
    expect(plan.step).toBeCloseTo(6 / HISTORY_STEPS_PER_DURATION, 12);
    expect(planHistory(slabModel({ duration: 12 })).step).toBeCloseTo(2 * plan.step, 12);
    expect(plan.isCoarse).toBe(false);
    expect(plan.slots).toBe(plan.neededSlots + HISTORY_MARGIN_SLOTS);
  });

  test('covers the view delay beyond each interface plus the chain before it', () => {
    const model = slabModel();
    const plan = planHistory(model);
    expect(plan.window).toBeCloseTo(Math.max(
      viewDelay(model, 1), chainDelay(model, 1) + viewDelay(model, 2)
    ), 9);
    expect((plan.neededSlots - 2) * plan.step).toBeGreaterThanOrEqual(plan.window - 1e-9);
  });

  test('keeps the window and coarsens the step when the slots run out', () => {
    const model = slabModel({ duration: 0.5 });
    const plan = planHistory(model, { maxTextureSize: 256 });
    expect(plan.isCoarse).toBe(true);
    expect(plan.slots).toBeLessThanOrEqual(256);
    expect((plan.neededSlots - 2) * plan.step).toBeCloseTo(plan.window, 9);
  });
});

/**
 * The GPU's streaming algorithm, transcribed: one ring buffer per subspace,
 * filled by evaluating the previous subspace at each site and step, and read
 * with the same clamp and linear interpolation as `historyAt` in the shader.
 */
class StreamingEmulator {
  constructor(model) {
    this.model = model;
    this.plan = planHistory(model);
    this.state = null;
    // Steps older than this were filled at a refill outside the guaranteed
    // part of the window, so they count as inexact. That holds the plan to the
    // window it promises, without the spare steps kept for scrubbing.
    this.guaranteedFrom = -Infinity;
    this.histories = model.subspaces.map((subspace) =>
      subspace.surfaceSamples.map(() => new Array(this.plan.slots).fill(null)));
  }

  advance(time) {
    const move = advanceHistory(this.state, time, this.plan);
    this.state = { epoch: move.epoch, newest: move.newest };
    const from = move.refill ? move.newest - this.plan.slots + 1 : move.from;
    if (move.refill) this.guaranteedFrom = move.newest - this.plan.neededSlots + 1;
    for (let j = 1; j < this.model.subspaces.length; j++) {
      const sites = this.model.subspaces[j].surfaceSamples;
      for (let m = from; m <= move.newest; m++) {
        const tau = this.state.epoch + m * this.plan.step;
        sites.forEach((site, i) => {
          const incident = this.sum(j - 1, site.x, site.y, tau - (site.delay ?? 0));
          this.histories[j][i][slotOf(m, this.plan.slots)] = {
            re: (site.tRe * incident.re - site.tIm * incident.im) * site.ds,
            im: (site.tRe * incident.im + site.tIm * incident.re) * site.ds,
            exact: incident.exact && m >= this.guaranteedFrom,
          };
        });
      }
    }
  }

  historyAt(j, i, tau) {
    const { slots, step } = this.plan;
    const { epoch, newest } = this.state;
    const raw = (tau - epoch) / step;
    const position = Math.min(Math.max(raw, newest - slots + 1), newest);
    const lower = Math.floor(position);
    const a = this.histories[j][i][slotOf(lower, slots)];
    const b = this.histories[j][i][slotOf(Math.min(lower + 1, newest), slots)];
    const f = position - lower;
    return {
      re: a.re + (b.re - a.re) * f,
      im: a.im + (b.im - a.im) * f,
      // Whether the value is the true history: not clamped to the window, and
      // built only from samples that were themselves exact.
      exact: raw >= newest - slots + 1 && raw <= newest && a.exact && b.exact,
    };
  }

  sum(j, x, y, t) {
    const subspace = this.model.subspaces[j];
    const wavelength = this.model.settings.wavelength;
    const n = subspace.refractiveIndex;
    const k = wavenumber(wavelength, n);
    const rMin = minimumRadius(wavelength, n);
    let re = 0;
    let im = 0;
    let exact = true;
    const add = (kernel, weight) => {
      re += kernel.re * weight.re - kernel.im * weight.im;
      im += kernel.re * weight.im + kernel.im * weight.re;
    };

    subspace.surfaceSamples.forEach((site, i) => {
      const dx = x - site.x;
      const dy = y - site.y;
      const d = Math.hypot(dx, dy);
      const r = Math.max(d, rMin);
      const weight = this.historyAt(j, i, t - n * d / wavelength);
      exact &&= weight.exact;
      add(rayleighSommerfeldKernel(k * r, (site.nx * dx + site.ny * dy) / r, k), weight);
    });
    for (const source of subspace.primaries) {
      const d = Math.hypot(x - source.x, y - source.y);
      const e = signalEnvelope(source.signal, t - n * d / wavelength);
      add(greensFunction(k * Math.max(d, rMin)), {
        re: source.re * e.re - source.im * e.im,
        im: source.re * e.im + source.im * e.re,
      });
    }
    return { re, im, exact };
  }

  fieldAt(point, time) {
    const j = subspaceIndexAt(this.model.interfaces, point.x, point.y, 1);
    return this.sum(j, point.x, point.y, time);
  }
}

describe('the streaming algorithm', () => {
  const model = slabModel();
  // Beyond the slab, on the axis and off it.
  const points = [{ x: 250, y: 0 }, { x: 300, y: 40 }];
  // 200 in air, 120 in glass, then the rest in air again.
  const arrivalAt = (x) => (200 + 1.5 * 120 + (x - 120)) / WAVELENGTH;

  const compare = (emulator, time) => {
    let worst = 0;
    let scale = 0;
    for (const point of points) {
      const exact = computeModelFieldAtTime(model, [point], time);
      const streamed = emulator.fieldAt(point, time);
      worst = Math.max(worst, Math.hypot(streamed.re - exact[0], streamed.im - exact[1]));
      scale = Math.max(scale, Math.hypot(exact[0], exact[1]));
    }
    return { worst, scale };
  };

  test('matches the direct recursion after a fresh fill, through both interfaces', () => {
    const emulator = new StreamingEmulator(model);
    const time = arrivalAt(250);
    emulator.advance(time);
    const { worst, scale } = compare(emulator, time);
    expect(scale).toBeGreaterThan(0);
    // Linear interpolation at a sixth of the duration costs about 1%.
    expect(worst / scale).toBeLessThan(0.02);
  });

  test('never reads outside the exact part of a history, anywhere in the view', () => {
    // The far corners of the view are where the delays reach the bound, so
    // they are what a too-short window would get wrong.
    const wide = wideSlabModel();
    const emulator = new StreamingEmulator(wide);
    const time = 100;
    emulator.advance(time);
    const { grid } = wide;
    const xs = [grid.originX, grid.originX + grid.stepX * (grid.width - 1)];
    const ys = [grid.originY, grid.originY + grid.stepY * (grid.height - 1)];
    for (const x of xs) {
      for (const y of ys) expect(emulator.fieldAt({ x, y }, time).exact).toBe(true);
    }
  });

  test('matches it as well after advancing step by step', () => {
    const emulator = new StreamingEmulator(model);
    const end = arrivalAt(250);
    for (let time = end - 24; time <= end + 1e-9; time += 0.73) emulator.advance(time);
    emulator.advance(end);
    const { worst, scale } = compare(emulator, end);
    expect(worst / scale).toBeLessThan(0.02);
  });
});

describe('time averaging and measurements', () => {
  test('averages a pulse over the scene span, and noise over many coherence times', () => {
    const pulse = slabModel({ duration: 6 });
    const times = averagingTimes(pulse);
    expect(times[times.length - 1]).toBeLessThan(sceneTimeSpan(pulse));
    expect(times[1] - times[0]).toBeCloseTo(6 / AVERAGE_SAMPLES_PER_DURATION, 1);

    const scene = makeScene();
    const source = new WavePointSource(scene);
    Object.assign(source, { x: 0, y: 0, amplitude: 1, signalType: 'noise', signalDuration: 3 });
    scene.objs.push(source);
    const noisy = averagingTimes(buildWaveModel(scene, { resolution: 64 }));
    expect(noisy[noisy.length - 1]).toBeGreaterThan(NOISE_AVERAGE_COHERENCE_TIMES * 3 * 0.99);
    expect(noisy.length).toBeLessThanOrEqual(MAX_AVERAGE_SAMPLES);
  });

  test('a screen outside the view lengthens the window to reach it', () => {
    const scene = makeScene();
    const source = new WavePointSource(scene);
    Object.assign(source, { x: -200, y: 0, amplitude: 1, signalType: 'pulse', signalDuration: 6 });
    scene.objs.push(source);
    addInterface(scene, 0, 80, 1.5);
    const without = planHistory(buildWaveModel(scene, { resolution: 64 })).window;
    const screen = new WaveScreen(scene);
    screen.p1 = { x: 6000, y: -100 };
    screen.p2 = { x: 6000, y: 100 };
    scene.objs.push(screen);
    const model = buildWaveModel(scene, { resolution: 64 });
    expect(model.measurementPoints).toHaveLength(2);
    expect(planHistory(model).window).toBeGreaterThan(without + 200);
  });
});
