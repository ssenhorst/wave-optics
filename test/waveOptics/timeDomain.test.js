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
 * Time-dependent sources: the signal model and the retarded evaluation in the
 * CPU reference engine.
 *
 * The model is the monochromatic one with each contribution weighted by its
 * source's envelope at the retarded time, so the checks are that it reduces to
 * the monochromatic field for a continuous wave, that a pulse arrives when and
 * as strongly as it should and leaves no wake, and that noise sources with
 * different seeds stop interfering.
 */

import Scene from '../../src/core/Scene.js';
import WavePointSource from '../../src/core/sceneObjs/wave/WavePointSource.js';
import WavePlaneWave from '../../src/core/sceneObjs/wave/WavePlaneWave.js';
import WaveLineSource from '../../src/core/sceneObjs/wave/WaveLineSource.js';
import WaveInterface from '../../src/core/sceneObjs/wave/WaveInterface.js';
import { buildWaveModel, isTimeDependent } from '../../src/core/waveOptics/waveSceneModel.js';
import {
  computeModelFieldAt, computeModelFieldAtTime
} from '../../src/core/waveOptics/WaveFieldEngineCpu.js';
import { greensFunction } from '../../src/core/waveOptics/hankel.js';
import { wavenumber } from '../../src/core/waveOptics/conventions.js';
import {
  resolveSignal, signalEnvelope, noiseEnvelope, hash32, SIGNAL_DEFAULTS
} from '../../src/core/waveOptics/signals.js';

const WAVELENGTH = 20;
const K = wavenumber(WAVELENGTH, 1);

function makeScene({ backgroundIndex = 1 } = {}) {
  const scene = new Scene();
  scene.waveOptics.wavelength = WAVELENGTH;
  scene.waveOptics.refractiveIndex = backgroundIndex;
  return scene;
}

function addPointSource(scene, props) {
  const source = new WavePointSource(scene);
  Object.assign(source, { x: 0, y: 0, amplitude: 1, phase: 0 }, props);
  scene.objs.push(source);
  return source;
}

function addInterface(scene, { x, y0, y1, indexAfter }) {
  const surface = new WaveInterface(scene);
  surface.p1 = { x, y: y0 };
  surface.p2 = { x, y: y1 };
  surface.refractiveIndexAfter = indexAfter;
  scene.objs.push(surface);
  return surface;
}

const magnitude = (field, i = 0) => Math.hypot(field[i * 2], field[i * 2 + 1]);

/** `|Psi|` at one point over a range of times, and where it peaks. */
function trace(model, point, from, to, step) {
  let peak = { time: from, value: -Infinity };
  const values = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const value = magnitude(computeModelFieldAtTime(model, [point], t));
    values.push({ time: t, value });
    if (value > peak.value) peak = { time: t, value };
  }
  return { values, peak };
}

/** Refine a peak by fitting a parabola through it and its neighbours. */
function refinedPeakTime({ values, peak }) {
  const i = values.findIndex((v) => v.time === peak.time);
  if (i <= 0 || i >= values.length - 1) return peak.time;
  const [a, b, c] = [values[i - 1].value, values[i].value, values[i + 1].value];
  const step = values[i + 1].time - values[i].time;
  return peak.time + 0.5 * step * (a - c) / (a - 2 * b + c);
}

describe('the signal model', () => {
  test('defaults to a continuous wave, which is omitted when saving', () => {
    const scene = makeScene();
    const source = addPointSource(scene, { x: 1, y: 2 });
    expect(resolveSignal(source).type).toBe('cw');
    const json = source.serialize();
    for (const key of Object.keys(SIGNAL_DEFAULTS)) expect(json).not.toHaveProperty(key);
  });

  test('a pulse survives a save and load', () => {
    const scene = makeScene();
    const source = addPointSource(scene, {
      signalType: 'pulse', signalDelay: 12, signalDuration: 3,
    });
    const restored = new WavePointSource(scene, source.serialize());
    expect(resolveSignal(restored)).toEqual({ type: 'pulse', delay: 12, duration: 3, seed: 0, position: 0 });
  });

  test('rejects unknown types and clamps the duration', () => {
    expect(resolveSignal({ signalType: 'laser' }).type).toBe('cw');
    expect(resolveSignal({ signalType: 'pulse', signalDuration: 0 }).duration).toBe(0.5);
  });

  test('a pulse has unit peak and the stated intensity FWHM', () => {
    const signal = { type: 'pulse', delay: 7, duration: 4, seed: 0 };
    expect(signalEnvelope(signal, 7).re).toBeCloseTo(1, 12);
    expect(signalEnvelope(signal, 9).re ** 2).toBeCloseTo(0.5, 12);
    expect(signalEnvelope(signal, 5).re ** 2).toBeCloseTo(0.5, 12);
  });

  test('a switch-on rises from 10% to 90% over its duration', () => {
    const signal = { type: 'switchOn', delay: 0, duration: 6, seed: 0 };
    expect(signalEnvelope(signal, -3).re).toBeCloseTo(0.1, 12);
    expect(signalEnvelope(signal, 3).re).toBeCloseTo(0.9, 12);
  });

  test('the hash gives unsigned 32-bit integers, spread evenly', () => {
    let sum = 0;
    const count = 10000;
    for (let i = 0; i < count; i++) {
      const h = hash32(i);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
      sum += h / 2 ** 32;
    }
    // The standard error of the mean of 10000 uniforms is 0.0029; allow four.
    expect(Math.abs(sum / count - 0.5)).toBeLessThan(0.012);
    // Negative knots wrap to large unsigned values rather than colliding.
    expect(hash32(-1)).toBe(hash32(0xffffffff));
    expect(hash32(-1)).not.toBe(hash32(1));
  });

  describe('noise', () => {
    const noise = (seed) => ({ type: 'noise', delay: 0, duration: 10, seed });

    test('has unit mean intensity, like the continuous wave it modulates', () => {
      let sum = 0;
      const count = 20000;
      for (let i = 0; i < count; i++) {
        const e = signalEnvelope(noise(3), i * 0.913);
        sum += e.re * e.re + e.im * e.im;
      }
      expect(Math.abs(sum / count - 1)).toBeLessThan(0.05);
    });

    test('changes smoothly, with no jumps', () => {
      // A field built by blending and renormalising phasors snaps round where
      // neighbouring knots are nearly opposite; a spline never does. The bound
      // is a few times the typical rate, far below what a jump would give.
      const dt = 0.002;
      let worst = 0;
      for (let t = 0; t < 1000; t += dt) {
        const a = signalEnvelope(noise(3), t);
        const b = signalEnvelope(noise(3), t + dt);
        worst = Math.max(worst, Math.hypot(b.re - a.re, b.im - a.im) / dt);
      }
      expect(worst * 10).toBeLessThan(5);
    });

    test('is the same realisation every time for a given seed', () => {
      expect(signalEnvelope(noise(5), 123.4)).toEqual(signalEnvelope(noise(5), 123.4));
      expect(signalEnvelope(noise(5), 123.4)).not.toEqual(signalEnvelope(noise(6), 123.4));
    });

    test('stays correlated well inside its coherence time and not beyond it', () => {
      const correlation = (lag) => {
        let re = 0;
        let im = 0;
        const count = 20000;
        for (let i = 0; i < count; i++) {
          const t = i * 0.73;
          const a = signalEnvelope(noise(1), t);
          const b = signalEnvelope(noise(1), t + lag);
          re += a.re * b.re + a.im * b.im;
          im += a.im * b.re - a.re * b.im;
        }
        return Math.hypot(re, im) / count;
      };
      expect(correlation(0.5)).toBeGreaterThan(0.95);
      // The coherence time is where the correlation has fallen to 1/e.
      expect(correlation(10)).toBeCloseTo(Math.exp(-1), 1);
      expect(correlation(30)).toBeLessThan(0.05);
    });
  });
});

describe('retarded evaluation', () => {
  test('a continuous wave reproduces the monochromatic field at any time', () => {
    const scene = makeScene();
    addPointSource(scene, { x: 0, y: 30, phase: 40 });
    addInterface(scene, { x: 200, y0: -600, y1: 600, indexAfter: 1.5 });
    const model = buildWaveModel(scene);
    expect(isTimeDependent(model)).toBe(false);

    const points = [{ x: 100, y: -20 }, { x: 350, y: 10 }, { x: 500, y: 120 }];
    const expected = computeModelFieldAt(model, points);
    for (const time of [0, 3.7, -120]) {
      const actual = computeModelFieldAtTime(model, points, time);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], 12);
      }
    }
  });

  describe('a pulse from a point source', () => {
    const DELAY = 10;
    const DURATION = 4;

    function pulseModel(backgroundIndex = 1) {
      const scene = makeScene({ backgroundIndex });
      addPointSource(scene, { signalType: 'pulse', signalDelay: DELAY, signalDuration: DURATION });
      return buildWaveModel(scene);
    }

    test('marks the model as time dependent', () => {
      expect(isTimeDependent(pulseModel())).toBe(true);
    });

    test.each([1, 1.5])('arrives after n r / lambda cycles in a medium of index %p', (n) => {
      const r = 40 * WAVELENGTH;
      const arrival = DELAY + n * r / WAVELENGTH;
      const result = trace(pulseModel(n), { x: r, y: 0 }, arrival - 10, arrival + 10, 0.25);
      expect(refinedPeakTime(result)).toBeCloseTo(arrival, 3);
    });

    test('peaks at the monochromatic amplitude', () => {
      const r = 40 * WAVELENGTH;
      const g = greensFunction(K * r);
      const peak = magnitude(computeModelFieldAtTime(pulseModel(), [{ x: r, y: 0 }], DELAY + 40));
      expect(peak).toBeCloseTo(Math.hypot(g.re, g.im), 12);
    });

    test('leaves no wake behind it, and nothing arrives early', () => {
      const r = 40 * WAVELENGTH;
      const model = pulseModel();
      const arrival = DELAY + 40;
      const at = (t) => magnitude(computeModelFieldAtTime(model, [{ x: r, y: 0 }], t));
      expect(at(arrival + 8 * DURATION) / at(arrival)).toBeLessThan(1e-12);
      expect(at(arrival - 8 * DURATION) / at(arrival)).toBeLessThan(1e-12);
    });

    test('its peak decays as 1/sqrt(r), conserving energy in the plane', () => {
      const model = pulseModel();
      const peakAt = (r) => magnitude(
        computeModelFieldAtTime(model, [{ x: r, y: 0 }], DELAY + r / WAVELENGTH)
      );
      expect(peakAt(40 * WAVELENGTH) / peakAt(160 * WAVELENGTH)).toBeCloseTo(2, 3);
    });
  });

  test('a switched-on source is dark before the front and the continuous wave after it', () => {
    const scene = makeScene();
    const source = addPointSource(scene, { signalType: 'switchOn', signalDelay: 0, signalDuration: 3 });
    const model = buildWaveModel(scene);
    const point = { x: 30 * WAVELENGTH, y: 0 };

    expect(magnitude(computeModelFieldAtTime(model, [point], 30 - 15))).toBeLessThan(1e-9);

    source.signalType = 'cw';
    const steady = computeModelFieldAt(buildWaveModel(scene), [point]);
    const late = computeModelFieldAtTime(model, [point], 30 + 40);
    expect(late[0]).toBeCloseTo(steady[0], 9);
    expect(late[1]).toBeCloseTo(steady[1], 9);
  });

  test('a plane-wave pulse passes its anchor at its delay and moves at c / n', () => {
    const scene = makeScene({ backgroundIndex: 1.25 });
    const wave = new WavePlaneWave(scene);
    Object.assign(wave, {
      x: 0, y: 0, amplitude: 1, angle: 0, signalType: 'pulse', signalDelay: 5, signalDuration: 3,
    });
    scene.objs.push(wave);
    const model = buildWaveModel(scene);

    const distance = 16 * WAVELENGTH;
    const arrival = 5 + 1.25 * distance / WAVELENGTH;
    const result = trace(model, { x: distance, y: 37 }, arrival - 6, arrival + 6, 0.25);
    expect(refinedPeakTime(result)).toBeCloseTo(arrival, 6);
    expect(result.peak.value).toBeCloseTo(1, 2);
  });

  test('a pulse through an interface is delayed by the optical path and keeps its amplitude', () => {
    const scene = makeScene();
    addPointSource(scene, { signalType: 'pulse', signalDelay: 0, signalDuration: 6 });
    addInterface(scene, { x: 10 * WAVELENGTH, y0: -1500, y1: 1500, indexAfter: 1.5 });
    const model = buildWaveModel(scene);
    const point = { x: 30 * WAVELENGTH, y: 0 };

    // 10 wavelengths in air, then 20 in glass.
    const arrival = 10 + 1.5 * 20;
    const result = trace(model, point, arrival - 6, arrival + 6, 0.5);
    expect(Math.abs(refinedPeakTime(result) - arrival)).toBeLessThan(0.2);

    // The envelope is slow compared with the carrier, so its peak carries the
    // monochromatic amplitude through the interface.
    scene.objs[0].signalType = 'cw';
    const steady = magnitude(computeModelFieldAt(buildWaveModel(scene), [point]));
    expect(result.peak.value / steady).toBeGreaterThan(0.95);
    expect(result.peak.value / steady).toBeLessThan(1.05);
  });

  describe('noise sources', () => {
    /**
     * Two sources on either side of the axis, driven out of phase so that the
     * continuous waves cancel on the axis. Averaged over many coherence times,
     * the intensity there shows whether they still interfere.
     */
    function averagedAxisIntensity(seedA, seedB) {
      const scene = makeScene();
      const common = { signalType: 'noise', signalDuration: 5 };
      addPointSource(scene, { ...common, y: -40, signalSeed: seedA });
      addPointSource(scene, { ...common, y: 40, phase: 180, signalSeed: seedB });
      const model = buildWaveModel(scene);
      const point = { x: 60 * WAVELENGTH, y: 0 };

      let sum = 0;
      const count = 2000;
      for (let i = 0; i < count; i++) {
        const value = magnitude(computeModelFieldAtTime(model, [point], i * 2.5));
        sum += value * value;
      }
      const g = greensFunction(K * Math.hypot(60 * WAVELENGTH, 40));
      return (sum / count) / (g.re * g.re + g.im * g.im);
    }

    test('with the same seed stay coherent and still cancel', () => {
      expect(averagedAxisIntensity(4, 4)).toBeLessThan(1e-12);
    });

    test('with different seeds add in intensity', () => {
      // Each source alone gives 1. Over ~1000 coherence times the cross term
      // averages to a few percent of that.
      expect(Math.abs(averagedAxisIntensity(4, 9) - 2)).toBeLessThan(0.2);
    });
  });
});

describe('the delay of a transmission phase', () => {
  /** An index-matched interface carrying a linear phase ramp, which steers a beam. */
  function rampScene(rampPerUnit) {
    const scene = makeScene();
    const wave = new WavePlaneWave(scene);
    Object.assign(wave, {
      x: -100, y: 0, amplitude: 1, angle: 0, signalType: 'pulse', signalDelay: 0, signalDuration: 6,
    });
    scene.objs.push(wave);
    const surface = addInterface(scene, { x: 0, y0: -600, y1: 600, indexAfter: 1 });
    surface.eqnPhase = `${rampPerUnit}\\cdot y`;
    return scene;
  }

  test('is the phase over 2 pi, counted from the thinnest point', () => {
    const ramp = 0.05;
    const model = buildWaveModel(rampScene(ramp));
    const sites = model.subspaces[1].surfaceSamples;
    expect(Math.min(...sites.map((site) => site.delay))).toBe(0);
    const first = sites[0];
    for (const site of sites) {
      expect(site.delay).toBeCloseTo(ramp * (site.y - first.y) / (2 * Math.PI), 9);
    }
  });

  test('a uniform phase adds no delay at all', () => {
    const scene = rampScene(0);
    scene.objs[1].eqnPhase = '2';
    const sites = buildWaveModel(scene).subspaces[1].surfaceSamples;
    expect(sites.every((site) => site.delay === 0)).toBe(true);
  });

  test('a steered pulse arrives when its phase front does', () => {
    // A ramp of k sin(theta) steers the beam by theta. The pulse travels with
    // the phase front, so it arrives at the stationary point's total delay:
    // the travel time plus the phase that site adds, over 2 pi.
    const sinTheta = 0.2;
    const ramp = K * sinTheta;
    const model = buildWaveModel(rampScene(ramp));
    const sites = model.subspaces[1].surfaceSamples;
    const yMin = Math.min(...sites.map((site) => site.y));

    const point = { x: 400, y: 0 };
    const tanTheta = sinTheta / Math.sqrt(1 - sinTheta * sinTheta);
    const stationary = point.y - point.x * tanTheta;
    const path = Math.hypot(point.x, point.y - stationary);
    const arrival = 100 / WAVELENGTH + ramp * (stationary - yMin) / (2 * Math.PI) + path / WAVELENGTH;

    const result = trace(model, point, arrival - 8, arrival + 8, 0.5);
    expect(Math.abs(refinedPeakTime(result) - arrival)).toBeLessThan(0.3);
  });
});

describe('spatial coherence of noise', () => {
  test('a point source reads the noise at position zero', () => {
    const signal = { type: 'noise', delay: 0, duration: 5, seed: 7, position: 0 };
    expect(signalEnvelope(signal, 12.3)).toEqual(noiseEnvelope(12.3, 5, 7, 0));
  });

  test('has unit mean intensity everywhere between knots, and no jumps along the line', () => {
    let sum = 0;
    let count = 0;
    let worst = 0;
    const du = 0.002;
    for (let i = 0; i < 400; i++) {
      const t = i * 3.7;
      for (let position = -3; position < 3; position += du) {
        const a = noiseEnvelope(t, 5, 7, position);
        const b = noiseEnvelope(t, 5, 7, position + du);
        sum += a.re * a.re + a.im * a.im;
        count++;
        worst = Math.max(worst, Math.hypot(b.re - a.re, b.im - a.im) / du);
      }
    }
    expect(Math.abs(sum / count - 1)).toBeLessThan(0.05);
    // Per coherence length; a jump would give thousands.
    expect(worst).toBeLessThan(5);
  });

  test('points close together fluctuate together, points far apart do not', () => {
    const correlation = (separation) => {
      let re = 0;
      let im = 0;
      let count = 0;
      for (let i = 0; i < 4000; i++) {
        const t = i * 1.3;
        const position = (i % 37) * 0.71;
        const a = noiseEnvelope(t, 5, 2, position);
        const b = noiseEnvelope(t, 5, 2, position + separation);
        re += a.re * b.re + a.im * b.im;
        im += a.im * b.re - a.re * b.im;
        count++;
      }
      return Math.hypot(re, im) / count;
    };
    expect(correlation(0.02)).toBeGreaterThan(0.95);
    expect(correlation(1)).toBeCloseTo(Math.exp(-1), 1);
    expect(correlation(3)).toBeLessThan(0.1);
  });

  /** A noise line source ten wavelengths long, centred on the origin. */
  function noisyLine({ spatialCoherence, coherenceLength = WAVELENGTH, sourceDensity = 8 }) {
    const scene = makeScene();
    scene.waveOptics.sourceDensity = sourceDensity;
    const line = new WaveLineSource(scene);
    Object.assign(line, {
      p1: { x: 0, y: -100 }, p2: { x: 0, y: 100 }, amplitude: 1,
      signalType: 'noise', signalDuration: 5, spatialCoherence, coherenceLength,
    });
    scene.objs.push(line);
    return buildWaveModel(scene);
  }

  /** The intensity averaged over many coherence times, at each point. */
  function averagedIntensity(model, points) {
    const sums = points.map(() => 0);
    const count = 400;
    for (let i = 0; i < count; i++) {
      const field = computeModelFieldAtTime(model, points, i * 2.5);
      points.forEach((_, p) => { sums[p] += field[p * 2] ** 2 + field[p * 2 + 1] ** 2; });
    }
    return sums.map((sum) => sum / count);
  }

  // On the axis, and at the coherent beam's first null, sin(theta) = lambda / L.
  const R = 2000;
  const NULL_SIN = WAVELENGTH / 200;
  const POINTS = [
    { x: R, y: 0 },
    { x: R * Math.sqrt(1 - NULL_SIN ** 2), y: R * NULL_SIN },
  ];

  test('a coherent line keeps its narrow beam, a partially coherent one spreads it', () => {
    const [axisC, nullC] = averagedIntensity(noisyLine({ spatialCoherence: 'coherent' }), POINTS);
    const [axisP, nullP] = averagedIntensity(noisyLine({ spatialCoherence: 'partial' }), POINTS);
    expect(nullC / axisC).toBeLessThan(0.05);
    expect(nullP / axisP).toBeGreaterThan(0.5);
  });

  test('a partially coherent line does not depend on how densely it is sampled', () => {
    const [coarse] = averagedIntensity(noisyLine({ spatialCoherence: 'partial', sourceDensity: 8 }), POINTS);
    const [fine] = averagedIntensity(noisyLine({ spatialCoherence: 'partial', sourceDensity: 16 }), POINTS);
    expect(Math.abs(fine / coarse - 1)).toBeLessThan(0.05);
  });

  test('a coherence length below half a wavelength is held there', () => {
    const tiny = noisyLine({ spatialCoherence: 'partial', coherenceLength: 1 });
    const half = noisyLine({ spatialCoherence: 'partial', coherenceLength: WAVELENGTH / 2 });
    const positions = (model) => model.subspaces[0].primaries.map((source) => source.signal.position);
    expect(positions(tiny)).toEqual(positions(half));
  });
});
