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
 * @file The reference implementation of the field summation, in plain
 * JavaScript.
 *
 * It is far slower than the WebGL backend and is not used to draw the app. It
 * exists so that the physics can be exercised by unit tests without a GL
 * context, and so the GPU backend has something to be checked against. The two
 * share the Hankel coefficient tables, so agreement between them is meaningful
 * only for the summation itself — which is exactly what needs checking.
 */

import { greensFunction, rayleighSommerfeldKernel } from './hankel.js';
import { wavenumber, minimumRadius } from './conventions.js';
import { gridSamplePosition, subspaceIndexAt } from './waveSceneModel.js';
import { signalEnvelope } from './signals.js';

/**
 * Evaluate the field at a list of points.
 *
 * Sources come in two kinds and are always ordered with the directional ones
 * first, matching the layout the GPU backend uses so the two cannot disagree
 * about which source is which:
 *
 * - The first `directionalCount` entries are points on an illuminated surface.
 *   They carry a forward normal `(nx, ny)` and re-radiate through the
 *   Rayleigh-Sommerfeld kernel, with the arc length they stand for already
 *   folded into their weight.
 * - The rest are isotropic point sources radiating the free-space Green's
 *   function.
 *
 * @param {Array<{x: number, y: number}>} points - Where to evaluate.
 * @param {Object} params
 * @param {WaveSource[]} params.sources
 * @param {number} params.wavelength - Vacuum wavelength in scene units.
 * @param {number} params.refractiveIndex - Index of the medium radiated into.
 * @param {number} [params.directionalCount=0] - How many leading sources are directional.
 * @param {Array<Object>} [params.planeWaves=[]] - Plane waves filling the medium,
 *   evaluated in closed form rather than as a sum of point sources.
 * @returns {Float64Array} Interleaved real and imaginary parts, `2 * points.length` long.
 */
export function computeFieldAt(points, {
  sources, wavelength, refractiveIndex = 1, directionalCount = 0, planeWaves = []
}) {
  const k = wavenumber(wavelength, refractiveIndex);
  const rMin = minimumRadius(wavelength, refractiveIndex);
  const out = new Float64Array(points.length * 2);

  for (let p = 0; p < points.length; p++) {
    const { x, y } = points[p];
    let re = 0;
    let im = 0;

    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      const dx = x - source.x;
      const dy = y - source.y;
      const r = Math.max(Math.hypot(dx, dy), rMin);

      const kernel = s < directionalCount
        ? rayleighSommerfeldKernel(k * r, (source.nx * dx + source.ny * dy) / r, k)
        : greensFunction(k * r);

      // Complex multiply: kernel * weight.
      re += kernel.re * source.re - kernel.im * source.im;
      im += kernel.re * source.im + kernel.im * source.re;
    }

    for (let w = 0; w < planeWaves.length; w++) {
      const wave = planeWaves[w];
      const phase = k * (wave.dirX * (x - wave.x) + wave.dirY * (y - wave.y));
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      re += cos * wave.re - sin * wave.im;
      im += cos * wave.im + sin * wave.re;
    }

    out[p * 2] = re;
    out[p * 2 + 1] = im;
  }

  return out;
}

/**
 * Evaluate the field over a sampling grid, in the same memory layout the GPU
 * backend produces: row 0 first, each sample a `(real, imaginary)` pair.
 *
 * @param {FieldGrid} grid
 * @param {Object} params - As for {@link computeFieldAt}.
 * @returns {Float64Array} `2 * grid.width * grid.height` long.
 */
export function computeFieldGrid(grid, params) {
  const points = new Array(grid.width * grid.height);
  for (let j = 0; j < grid.height; j++) {
    for (let i = 0; i < grid.width; i++) {
      points[j * grid.width + i] = gridSamplePosition(grid, i, j);
    }
  }
  return computeFieldAt(points, params);
}

/**
 * Run the propagation chain over a model's subspaces.
 *
 * Subspace by subspace along the optical axis, the field arriving at the next
 * interface is evaluated at each of its sample sites, multiplied by the complex
 * transmission there and by the arc length the site stands for, and becomes a
 * secondary source radiating into the subspace beyond. The incident field is
 * evaluated with the wavenumber of the medium it travelled through, and the
 * re-radiation uses the wavenumber of the medium it enters; that difference is
 * the whole of the refraction in this model.
 *
 * This is the reference implementation. The GPU backend does the same thing,
 * but the chain here is what the tests check against closed-form results.
 *
 * @param {Object} model - As built by `buildWaveModel`.
 * @returns {Array<{refractiveIndex: number, sources: Array, directionalCount: number,
 *   lowerBoundary: Object|null, upperBoundary: Object|null}>}
 */
export function propagateChain(model) {
  const { subspaces, settings } = model;
  const resolved = [];

  for (let j = 0; j < subspaces.length; j++) {
    const subspace = subspaces[j];
    let directional = [];

    if (j > 0 && subspace.surfaceSamples.length > 0) {
      const previous = resolved[j - 1];
      const incident = computeFieldAt(subspace.surfaceSamples, {
        sources: previous.sources,
        wavelength: settings.wavelength,
        refractiveIndex: subspaces[j - 1].refractiveIndex,
        directionalCount: previous.directionalCount,
        planeWaves: previous.planeWaves,
      });

      directional = subspace.surfaceSamples.map((site, i) => {
        const incidentRe = incident[i * 2];
        const incidentIm = incident[i * 2 + 1];
        // weight = transmission * incident field * arc length.
        return {
          x: site.x,
          y: site.y,
          nx: site.nx,
          ny: site.ny,
          re: (site.tRe * incidentRe - site.tIm * incidentIm) * site.ds,
          im: (site.tRe * incidentIm + site.tIm * incidentRe) * site.ds,
        };
      });
    }

    resolved.push({
      refractiveIndex: subspace.refractiveIndex,
      sources: [...directional, ...subspace.primaries],
      directionalCount: directional.length,
      planeWaves: subspace.planeWaves ?? [],
      lowerBoundary: subspace.lowerBoundary,
      upperBoundary: subspace.upperBoundary,
    });
  }

  return resolved;
}

/**
 * Evaluate a propagated model at arbitrary points, using each point's own
 * subspace.
 *
 * @param {Object} model - As built by `buildWaveModel`.
 * @param {Array<{x: number, y: number}>} points
 * @returns {Float64Array} Interleaved real and imaginary parts.
 */
export function computeModelFieldAt(model, points) {
  const resolved = propagateChain(model);
  const out = new Float64Array(points.length * 2);

  // Group the points by subspace so each subspace is summed over once.
  const bySubspace = new Map();
  points.forEach((point, index) => {
    const j = subspaceIndexAt(
      model.interfaces, point.x, point.y, model.settings?.axisSign ?? 1
    );
    if (!bySubspace.has(j)) bySubspace.set(j, []);
    bySubspace.get(j).push(index);
  });

  for (const [j, indices] of bySubspace) {
    const subspace = resolved[j];
    const values = computeFieldAt(indices.map((i) => points[i]), {
      sources: subspace.sources,
      wavelength: model.settings.wavelength,
      refractiveIndex: subspace.refractiveIndex,
      directionalCount: subspace.directionalCount,
      planeWaves: subspace.planeWaves,
    });
    indices.forEach((pointIndex, k) => {
      out[pointIndex * 2] = values[k * 2];
      out[pointIndex * 2 + 1] = values[k * 2 + 1];
    });
  }

  return out;
}

/**
 * Evaluate the time-dependent field of a model at arbitrary points and one
 * instant, as the complex envelope-weighted phasor `Psi(r, t)` described in
 * `signals.js`. The real field is `Re{ Psi e^{-i 2 pi t} }`, which
 * {@link instantaneousField} gives with a phase of `2 pi t`.
 *
 * Each contribution is the monochromatic one — the same Green's function,
 * Rayleigh-Sommerfeld kernel and plane-wave phase as {@link computeFieldAt} —
 * multiplied by its source's envelope at the retarded time. A site on an
 * interface re-radiates the field that arrived at it, so its envelope is the
 * previous subspace's field at the site, evaluated earlier by the time the
 * light takes from the site to the observer.
 *
 * This is the reference implementation and evaluates that recursion directly,
 * with no history buffers and so no interpolation. The cost is the product of
 * the site counts of every interface on the way, which is fine for the few
 * points and interfaces a test uses and nothing more. With continuous-wave
 * sources it reproduces {@link computeModelFieldAt} exactly, at any time.
 *
 * @param {Object} model - As built by `buildWaveModel`.
 * @param {Array<{x: number, y: number}>} points
 * @param {number} time - In vacuum optical cycles.
 * @returns {Float64Array} Interleaved real and imaginary parts of `Psi`.
 */
export function computeModelFieldAtTime(model, points, time) {
  const { subspaces, interfaces, settings } = model;
  const wavelength = settings.wavelength;
  const axisSign = settings?.axisSign ?? 1;

  // Per subspace: wavenumber, clamp radius and retardation per unit length.
  const media = subspaces.map((subspace) => ({
    k: wavenumber(wavelength, subspace.refractiveIndex),
    rMin: minimumRadius(wavelength, subspace.refractiveIndex),
    delayPerLength: subspace.refractiveIndex / wavelength,
  }));

  const evaluate = (j, x, y, t) => {
    const subspace = subspaces[j];
    const { k, rMin, delayPerLength } = media[j];
    let re = 0;
    let im = 0;

    const accumulate = (kernel, weightRe, weightIm, envelope) => {
      // kernel * weight * envelope, all complex.
      const kwRe = kernel.re * weightRe - kernel.im * weightIm;
      const kwIm = kernel.re * weightIm + kernel.im * weightRe;
      re += kwRe * envelope.re - kwIm * envelope.im;
      im += kwRe * envelope.im + kwIm * envelope.re;
    };

    if (j > 0) {
      for (const site of subspace.surfaceSamples) {
        const dx = x - site.x;
        const dy = y - site.y;
        const distance = Math.hypot(dx, dy);
        const r = Math.max(distance, rMin);
        const incident = evaluate(j - 1, site.x, site.y, t - delayPerLength * distance);
        // transmission * incident field * arc length, as in propagateChain.
        accumulate(
          rayleighSommerfeldKernel(k * r, (site.nx * dx + site.ny * dy) / r, k),
          (site.tRe * incident.re - site.tIm * incident.im) * site.ds,
          (site.tRe * incident.im + site.tIm * incident.re) * site.ds,
          { re: 1, im: 0 }
        );
      }
    }

    for (const source of subspace.primaries) {
      const distance = Math.hypot(x - source.x, y - source.y);
      const r = Math.max(distance, rMin);
      accumulate(
        greensFunction(k * r), source.re, source.im,
        signalEnvelope(source.signal, t - delayPerLength * distance)
      );
    }

    for (const wave of subspace.planeWaves ?? []) {
      // Distance travelled past the anchor, which may be negative: the anchor
      // is where the wave has the delay its signal states.
      const travelled = wave.dirX * (x - wave.x) + wave.dirY * (y - wave.y);
      const phase = k * travelled;
      accumulate(
        { re: Math.cos(phase), im: Math.sin(phase) }, wave.re, wave.im,
        signalEnvelope(wave.signal, t - delayPerLength * travelled)
      );
    }

    return { re, im };
  };

  const out = new Float64Array(points.length * 2);
  points.forEach((point, index) => {
    const j = subspaceIndexAt(interfaces, point.x, point.y, axisSign);
    const value = evaluate(j, point.x, point.y, time);
    out[index * 2] = value.re;
    out[index * 2 + 1] = value.im;
  });
  return out;
}

/**
 * The amplitude `|U|` at each sample of an interleaved complex field.
 * @param {Float64Array|Float32Array} field
 * @returns {Float64Array}
 */
export function fieldAmplitudes(field) {
  const out = new Float64Array(field.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.hypot(field[i * 2], field[i * 2 + 1]);
  }
  return out;
}

/**
 * The instantaneous real field `Re{ U e^{-i w t} }` at a given phase.
 * @param {Float64Array|Float32Array} field - Interleaved complex field.
 * @param {number} phase - The quantity `w t`, in radians.
 * @returns {Float64Array}
 */
export function instantaneousField(field, phase) {
  const cos = Math.cos(phase);
  const sin = Math.sin(phase);
  const out = new Float64Array(field.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = field[i * 2] * cos + field[i * 2 + 1] * sin;
  }
  return out;
}

export default {
  computeFieldAt,
  computeFieldGrid,
  propagateChain,
  computeModelFieldAt,
  computeModelFieldAtTime,
  fieldAmplitudes,
  instantaneousField,
};
