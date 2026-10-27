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
 * @file Turns a {@link Scene} into the flat description the field engines
 * consume, and works out the sampling grid.
 *
 * At this stage the model is a single homogeneous subspace. When interfaces
 * arrive it grows into an ordered stack of subspaces, but the grid layout and
 * the source-collection protocol below stay as they are.
 */

import {
  DEFAULT_WAVELENGTH, DEFAULT_REFRACTIVE_INDEX, DEFAULT_GRID_RESOLUTION,
  DEFAULT_SOURCE_DENSITY, MAX_SOURCES, samplingDiagnostics
} from './conventions.js';
import { DEFAULT_PHASE_CHROMA } from './oklch.js';
import { RESOLUTION_LADDER } from './adaptiveResolution.js';
import { resolveSignal, isContinuousWave } from './signals.js';

/**
 * @typedef {Object} WaveSource
 * @property {number} x - Position along the optical axis, in scene units.
 * @property {number} y - Transverse position, in scene units.
 * @property {number} re - Real part of the complex weight.
 * @property {number} im - Imaginary part of the complex weight.
 * @property {WaveSignal} [signal] - The time dependence, see `signals.js`;
 *   a continuous wave when absent.
 */

/**
 * @typedef {Object} Subspace
 * @property {number} refractiveIndex - Index of the medium filling this subspace.
 * @property {Array<Object>} surfaceSamples - Sites on the interface bounding this
 *   subspace from below, which re-radiate into it. Empty for the first subspace.
 * @property {WaveSource[]} primaries - Isotropic sources located in this subspace.
 * @property {Array<Object>} planeWaves - Plane waves filling this subspace.
 * @property {Object|null} lowerBoundary - The interface before this subspace.
 * @property {Object|null} upperBoundary - The interface after this subspace.
 */

/**
 * @typedef {Object} FieldGrid
 * @property {number} width - Samples across the grid.
 * @property {number} height - Samples down the grid.
 * @property {number} originX - Scene x of the first sample's centre.
 * @property {number} originY - Scene y of the first sample's centre.
 * @property {number} stepX - Scene x per sample; positive.
 * @property {number} stepY - Scene y per sample; negative, see below.
 * @property {number} spacing - The larger of the two step magnitudes.
 * @property {number} extent - The diagonal of the covered region, in scene units.
 */

/**
 * Resolve a scene's wave-optics settings, filling in anything missing.
 * @param {Scene} scene
 * @returns {Object}
 */
export function resolveWaveSettings(scene) {
  const stored = scene?.waveOptics ?? {};
  const resolved = {
    wavelength: positiveOr(stored.wavelength, DEFAULT_WAVELENGTH),
    refractiveIndex: positiveOr(stored.refractiveIndex, DEFAULT_REFRACTIVE_INDEX),
    gridResolution: positiveOr(stored.gridResolution, DEFAULT_GRID_RESOLUTION),
    autoResolution: stored.autoResolution !== false,
    sourceDensity: positiveOr(stored.sourceDensity, DEFAULT_SOURCE_DENSITY),
    view: stored.view ?? 'intensity',
    // Whether the instantaneous views run their clock. Saved with the scene because whether a
    // figure moves is part of what the figure is, not a preference of whoever opens it.
    animated: Boolean(stored.animated),
    intensityColormap: stored.intensityColormap ?? 'magma',
    fieldColormap: stored.fieldColormap ?? 'twilight',
    phaseChroma: clamp(stored.phaseChroma ?? DEFAULT_PHASE_CHROMA, 0, 0.4),
    scalePercentile: clamp(stored.scalePercentile ?? 99, 1, 100),
    upperCutoff: positiveOr(stored.upperCutoff, 1),
    lowerCutoff: clamp(stored.lowerCutoff ?? 0, 0, 0.999),
    logScale: Boolean(stored.logScale),
    dynamicRange: positiveOr(stored.dynamicRange, 40),
    reversed: Boolean(stored.reversed),
  };

  /**
   * Which way along the canvas `x` axis light travels: `+1` for left to right,
   * `-1` for right to left.
   *
   * Everything in this directory is written for light travelling towards `+x`,
   * and reversing it is a single sign rather than a second set of formulas:
   * surfaces order the other way, a surface's forward normal points the other
   * way, and the subspace a point belongs to is decided by the reversed
   * comparison. The Green's function is isotropic and so is a line source, so
   * neither notices.
   */
  resolved.axisSign = resolved.reversed ? -1 : 1;

  // In automatic mode the ladder is free to climb to the top; otherwise the
  // chosen resolution is both the target and the cap.
  resolved.targetResolution = resolved.autoResolution
    ? RESOLUTION_LADDER.at(-1)
    : resolved.gridResolution;
  return resolved;
}

/**
 * Collect every wave source contributed by the objects in a scene.
 *
 * Objects opt in by implementing `getWaveSources`, which keeps the ray-only
 * scene objects inert here without needing a type check per class.
 *
 * @param {Scene} scene
 * @param {Object} context - Passed through to each object.
 * @returns {WaveSource[]}
 */
export function collectWaveSources(scene, context = {}) {
  const sources = [];
  for (const obj of scene.objs ?? []) {
    if (typeof obj?.getWaveSources !== 'function') continue;
    const contributed = obj.getWaveSources(context);
    if (!contributed) continue;
    for (const source of contributed) {
      if (Number.isFinite(source.x) && Number.isFinite(source.y) &&
        Number.isFinite(source.re) && Number.isFinite(source.im)) {
        sources.push(source);
      }
    }
  }
  return sources;
}

/**
 * How many point sources a scene would produce at a given sampling density,
 * without doing the sampling. Counts both the primary sources and the sites on
 * every interface, since both are summed over by the field pass.
 *
 * @param {Scene} scene
 * @param {Object} context
 * @returns {number}
 */
export function countWaveSources(scene, context = {}) {
  let total = 0;
  for (const obj of scene.objs ?? []) {
    if (typeof obj?.getWaveSources === 'function') {
      total += typeof obj.getWaveSourceCount === 'function'
        ? obj.getWaveSourceCount(context)
        : 1;
    }
  }

  // Interfaces are sampled with the larger of the two indices bounding them,
  // which the ordered stack knows; approximating with the background index
  // here is enough for a budget estimate and avoids building the stack twice.
  let previousIndex = context.settings?.refractiveIndex ?? 1;
  for (const surface of collectInterfaces(scene, context.settings?.axisSign ?? 1)) {
    total += surface.getSurfaceSampleCount({
      ...context, refractiveIndexBefore: previousIndex
    });
    previousIndex = surface.refractiveIndexAfter;
  }
  return total;
}

/**
 * The valid interfaces in a scene, ordered along the optical axis.
 *
 * An object may present more than one surface: a lens is two refracting
 * surfaces with glass between them, and the subspace stack has to see both, in
 * order, with the glass as the medium between. Objects that are a single
 * surface are their own surface, which is the common case.
 *
 * @param {Scene} scene
 * @param {number} [axisSign=1] - Which way light travels along `x`.
 * @returns {Array<Object>}
 */
export function collectInterfaces(scene, axisSign = 1) {
  const surfaces = [];
  for (const obj of scene.objs ?? []) {
    if (typeof obj?.getSurfaces === 'function') {
      for (const surface of obj.getSurfaces() ?? []) {
        if (typeof surface?.getSurfaceSamples === 'function' && surface.isValid?.()) {
          surfaces.push(surface);
        }
      }
    } else if (typeof obj?.getSurfaceSamples === 'function' && obj.isValid?.()) {
      surfaces.push(obj);
    }
  }
  // Ordered along the direction of travel, so "the interface before this one"
  // means the same thing whichever way the light is going.
  return surfaces.sort((a, b) => axisSign * (a.meanZ() - b.meanZ()));
}

/**
 * Build the ordered stack of subspaces.
 *
 * Space is divided by the interfaces into subspaces numbered along the optical
 * axis. Each holds the sites on the interface that precedes it, which radiate
 * into it, plus whatever primary sources sit inside it. The field in a subspace
 * is the sum over exactly those, using that subspace's refractive index; there
 * is no backward propagation and no interaction between interfaces other than
 * through this chain.
 *
 * @param {Scene} scene
 * @param {Object} settings - Resolved wave settings.
 * @param {number} samplesPerWavelength
 * @returns {{subspaces: Subspace[], interfaces: Array<Object>, warnings: string[]}}
 */
export function buildSubspaceStack(scene, settings, samplesPerWavelength) {
  const axisSign = settings.axisSign ?? 1;
  const interfaces = collectInterfaces(scene, axisSign);
  const warnings = [];

  const subspaces = [{
    refractiveIndex: settings.refractiveIndex,
    surfaceSamples: [],
    primaries: [],
    planeWaves: [],
    lowerBoundary: null,
    upperBoundary: interfaces[0] ?? null,
  }];

  for (let i = 0; i < interfaces.length; i++) {
    const surface = interfaces[i];
    const before = subspaces[i].refractiveIndex;
    subspaces.push({
      refractiveIndex: positiveOr(surface.refractiveIndexAfter, 1),
      surfaceSamples: surface.getSurfaceSamples({
        scene, settings, samplesPerWavelength, refractiveIndexBefore: before, axisSign
      }),
      primaries: [],
      planeWaves: [],
      lowerBoundary: surface,
      upperBoundary: interfaces[i + 1] ?? null,
    });

    // Overlapping interfaces have no well-defined order, so the subspace a
    // point belongs to becomes ambiguous. The comparison is in the direction of
    // travel: where one surface ends and the next begins swap over when the
    // axis is reversed, and comparing raw x would then report every scene with
    // two surfaces in it as overlapping.
    if (i > 0) {
      const previous = interfaces[i - 1].getAxialRange();
      const current = surface.getAxialRange();
      if (previous && current) {
        const previousEnd = axisSign > 0 ? previous.max : previous.min;
        const currentStart = axisSign > 0 ? current.min : current.max;
        if (axisSign * currentStart < axisSign * previousEnd) {
          warnings.push('interfacesOverlap');
        }
      }
    }
  }

  // Place each source in the subspace it sits in. Every sample of an object
  // shares that object's signal, which the monochromatic engines ignore and the
  // time-domain evaluation reads.
  for (const obj of scene.objs ?? []) {
    const signal = resolveSignal(obj);
    if (typeof obj?.getWaveSources === 'function') {
      const contributed = obj.getWaveSources({ scene, settings, samplesPerWavelength });
      for (const source of contributed ?? []) {
        if (!Number.isFinite(source.x) || !Number.isFinite(source.y) ||
          !Number.isFinite(source.re) || !Number.isFinite(source.im)) continue;
        source.signal ??= signal;
        subspaces[subspaceIndexAt(interfaces, source.x, source.y, axisSign)].primaries.push(source);
      }
    }

    // A plane wave has no extent, so its anchor decides which subspace it
    // fills; it then stops at that subspace's far boundary like anything else.
    if (typeof obj?.getPlaneWaves === 'function') {
      const waves = obj.getPlaneWaves({ scene, settings });
      for (const wave of waves ?? []) {
        if (!Number.isFinite(wave.x) || !Number.isFinite(wave.y) ||
          !Number.isFinite(wave.re) || !Number.isFinite(wave.im)) continue;
        wave.signal ??= signal;
        subspaces[subspaceIndexAt(interfaces, wave.x, wave.y, axisSign)].planeWaves.push(wave);
      }
    }
  }

  return { subspaces, interfaces, warnings: [...new Set(warnings)] };
}

/**
 * Whether any source in a model has a time dependence beyond the continuous
 * wave, which is what decides whether the scene needs the time-domain engine.
 *
 * @param {Object} model - As built by `buildWaveModel`.
 * @returns {boolean}
 */
export function isTimeDependent(model) {
  return (model?.subspaces ?? []).some((subspace) =>
    subspace.primaries.some((source) => !isContinuousWave(source.signal)) ||
    subspace.planeWaves.some((wave) => !isContinuousWave(wave.signal)));
}

/**
 * Which subspace a point lies in.
 *
 * @param {Array<Object>} interfaces - Ordered interfaces.
 * @param {number} z - Position along the optical axis.
 * @param {number} y - Transverse position.
 * @param {number} [axisSign=1] - Which way light travels along `x`.
 * @returns {number}
 */
export function subspaceIndexAt(interfaces, z, y, axisSign = 1) {
  let index = 0;
  for (const surface of interfaces) {
    if (axisSign * z >= axisSign * surface.zAt(y)) index++; else break;
  }
  return index;
}

/**
 * Choose the sampling density that fits within the source budget.
 *
 * Exceeding the budget is reduced by lowering the density for every source
 * uniformly, rather than by truncating the source list: a shorter list would
 * silently delete part of a source, whereas a lower density degrades the whole
 * scene in a way the diagnostics can report honestly.
 *
 * @param {Scene} scene
 * @param {Object} settings - Resolved wave settings.
 * @returns {{samplesPerWavelength: number, isReduced: boolean}}
 */
export function resolveSourceDensity(scene, settings) {
  const requested = settings.sourceDensity;
  const count = countWaveSources(scene, {
    scene, settings, samplesPerWavelength: requested
  });
  if (count <= MAX_SOURCES) {
    return { samplesPerWavelength: requested, isReduced: false };
  }
  return {
    samplesPerWavelength: requested * (MAX_SOURCES / count),
    isReduced: true,
  };
}

/**
 * Lay out the sampling grid over the current viewport.
 *
 * The grid is viewport-aligned, so the requested resolution counts samples
 * across the *longer* viewport axis and the shorter axis follows from the
 * aspect ratio. That keeps the samples square, which is what the aliasing
 * diagnostics assume.
 *
 * `stepY` is negative: WebGL row 0 is the bottom of the framebuffer, which is
 * the bottom of the screen, which is the *largest* scene y (scene y grows
 * downward). Encoding the flip in the step means the field pass and the
 * display pass agree without either of them flipping a texture coordinate.
 *
 * @param {Scene} scene
 * @param {number} resolution - Samples across the longer viewport axis.
 * @returns {FieldGrid}
 */
export function computeFieldGrid(scene, resolution) {
  const viewportWidth = Math.max(1, scene.width);
  const viewportHeight = Math.max(1, scene.height);
  const scale = scene.scale || 1;

  const samples = Math.max(2, Math.round(resolution));
  const isLandscape = viewportWidth >= viewportHeight;
  const width = isLandscape
    ? samples
    : Math.max(2, Math.round(samples * viewportWidth / viewportHeight));
  const height = isLandscape
    ? Math.max(2, Math.round(samples * viewportHeight / viewportWidth))
    : samples;

  // The viewport in scene coordinates: screen = scene * scale + origin.
  const sceneLeft = -scene.origin.x / scale;
  const sceneTop = -scene.origin.y / scale;
  const sceneWidth = viewportWidth / scale;
  const sceneHeight = viewportHeight / scale;

  const stepX = sceneWidth / width;
  const stepY = sceneHeight / height;

  return {
    width,
    height,
    originX: sceneLeft + 0.5 * stepX,
    originY: sceneTop + sceneHeight - 0.5 * stepY,
    stepX,
    stepY: -stepY,
    spacing: Math.max(stepX, stepY),
    extent: Math.hypot(sceneWidth, sceneHeight),
  };
}

/**
 * The scene position of one grid sample.
 * @param {FieldGrid} grid
 * @param {number} i - Column index.
 * @param {number} j - Row index, counting from the bottom.
 * @returns {{x: number, y: number}}
 */
export function gridSamplePosition(grid, i, j) {
  return {
    x: grid.originX + grid.stepX * i,
    y: grid.originY + grid.stepY * j,
  };
}

/**
 * Build the complete description of what is to be computed.
 *
 * @param {Scene} scene
 * @param {Object} [options]
 * @param {number} [options.resolution] - Overrides the stored grid resolution,
 *   used to drop to a coarse grid while the user is interacting.
 * @returns {{settings: Object, sources: WaveSource[], grid: FieldGrid, diagnostics: Object}}
 */
export function buildWaveModel(scene, { resolution, resolveResolution } = {}) {
  const settings = resolveWaveSettings(scene);
  const density = resolveSourceDensity(scene, settings);
  const { subspaces, interfaces, warnings } = buildSubspaceStack(
    scene, settings, density.samplesPerWavelength
  );

  let sourceCount = 0;
  let largestIndex = settings.refractiveIndex;
  for (const subspace of subspaces) {
    sourceCount += subspace.surfaceSamples.length + subspace.primaries.length
      + subspace.planeWaves.length;
    largestIndex = Math.max(largestIndex, subspace.refractiveIndex);
  }

  // The grid is laid out after the sources are known, so a caller sizing the
  // grid to a time budget can take the source count into account.
  const chosen = resolveResolution
    ? resolveResolution(sourceCount)
    : (resolution ?? settings.targetResolution);
  const grid = computeFieldGrid(scene, chosen);

  // Points the measurements read the field at. The time-domain histories have
  // to cover the delays to these as well as to the view, since a screen may
  // reach outside it.
  const measurementPoints = [];
  for (const obj of scene.objs ?? []) {
    for (const point of obj?.getMeasurementPoints?.() ?? []) {
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) measurementPoints.push(point);
    }
  }

  return {
    settings,
    axisSign: settings.axisSign,
    subspaces,
    interfaces,
    grid,
    warnings,
    measurementPoints,
    diagnostics: {
      sourceCount,
      interfaceCount: interfaces.length,
      isDensityReduced: density.isReduced,
      ...samplingDiagnostics({
        gridSpacing: grid.spacing,
        wavelength: settings.wavelength,
        // The shortest wavelength anywhere in the scene sets the sampling
        // requirement, so the diagnostics use the largest index present.
        refractiveIndex: largestIndex,
        sceneExtent: grid.extent,
        samplesPerWavelength: density.samplesPerWavelength,
        view: settings.view,
      }),
    },
  };
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}
