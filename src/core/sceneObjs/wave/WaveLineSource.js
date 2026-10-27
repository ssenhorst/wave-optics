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

import BaseSceneObj from '../BaseSceneObj.js';
import LineObjMixin from '../LineObjMixin.js';
import geometry from '../../geometry.js';
import i18next from 'i18next';
import { evaluateLatex } from '../../equation.js';
import { wavelengthInMedium } from '../../waveOptics/conventions.js';
import { SIGNAL_DEFAULTS } from '../../waveOptics/signals.js';
import {
  equationInfo, amplitudeExamples, phaseExamples
} from './waveEquationInfo.js';

/**
 * A line of time-harmonic point sources: the wave-optics counterpart of a beam.
 *
 * The amplitude and phase may vary along the line through equations in `u`, the
 * arc length from the centre of the line in scene units. That is enough to
 * build a tilted plane wave (`phase = k sin(theta) u`), a focusing wavefront
 * (`phase = -k u^2 / (2 f)`), an apodised aperture, or a grating.
 *
 * The line is a continuous source, and each sample carries the arc length it
 * stands for. Without that weighting the total emitted field would scale with
 * the sampling density, which would turn the density control into a physical
 * parameter instead of an accuracy one. With it, raising the density makes the
 * result converge and then stop changing.
 *
 * Tools -> Sources -> Line source
 * @class
 * @extends BaseSceneObj
 * @memberof sceneObjs
 * @property {Point} p1 - The first endpoint of the line.
 * @property {Point} p2 - The second endpoint of the line.
 * @property {number} amplitude - Overall amplitude, per unit length.
 * @property {string} eqnAmplitude - Amplitude as a function of `u`, in LaTeX.
 * @property {string} eqnPhase - Phase in radians as a function of `u`, in LaTeX.
 */
class WaveLineSource extends LineObjMixin(BaseSceneObj) {
  static type = 'WaveLineSource';
  static isOptical = true;
  static serializableDefaults = {
    p1: null,
    p2: null,
    amplitude: 1,
    eqnAmplitude: '1',
    eqnPhase: '0',
    ...SIGNAL_DEFAULTS
  };

  static getDescription(objData, scene, detailed = false) {
    return i18next.t('main:waveTools.WaveLineSource.title');
  }

  /** Popover content for the two equation fields. */
  static equationHelp(scene) {
    const variable = i18next.t('simulator:waveSceneObjs.common.uInfo');
    return {
      amplitude: equationInfo({ variable, examples: amplitudeExamples('u') }),
      phase: equationInfo({
        role: i18next.t('simulator:waveSceneObjs.common.phaseRadiansInfo'),
        variable,
        examples: phaseExamples('u'),
      }),
    };
  }

  static getPropertySchema(objData, scene) {
    const help = WaveLineSource.equationHelp(scene);
    return [
      ...super.getPropertySchema(objData, scene),
      { key: 'amplitude', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.amplitude') },
      { key: 'eqnAmplitude', type: 'equation', label: 'A(u)', variables: ['u'], info: help.amplitude },
      { key: 'eqnPhase', type: 'equation', label: 'φ(u)', variables: ['u'], info: help.phase },
    ];
  }

  populateObjBar(objBar) {
    const help = WaveLineSource.equationHelp(this.scene);
    objBar.setTitle(i18next.t('main:waveTools.WaveLineSource.title'));
    objBar.createNumber(
      i18next.t('simulator:waveSceneObjs.common.amplitude'), 0, 5, 0.01, this.amplitude,
      function (obj, value) { obj.amplitude = value; },
      '<p>' + i18next.t('simulator:waveSceneObjs.common.amplitudeDensityInfo') + '</p>'
    );
    objBar.createEquation('A(u)', this.eqnAmplitude, function (obj, value) {
      obj.eqnAmplitude = value;
    }, help.amplitude);
    objBar.createEquation('φ(u)', this.eqnPhase, function (obj, value) {
      obj.eqnPhase = value;
    }, help.phase);
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    // Drawn above the field, which is opaque; see WavePointSource.
    if (!isAboveLight) return;

    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;

    if (this.p1.x === this.p2.x && this.p1.y === this.p2.y) {
      ctx.fillStyle = 'rgb(128,128,128)';
      ctx.fillRect(this.p1.x - 1.5 * ls, this.p1.y - 1.5 * ls, 3 * ls, 3 * ls);
      return;
    }

    ctx.strokeStyle = isHovered
      ? this.scene.highlightColorCss
      : canvasRenderer.rgbaToCssColor(this.scene.theme.lightSource.color);
    ctx.lineWidth = this.scene.theme.lightSource.size * 0.6 * ls;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(this.p1.x, this.p1.y);
    ctx.lineTo(this.p2.x, this.p2.y);
    ctx.stroke();
    ctx.lineWidth = 1 * ls;

    // The endpoints are drag handles, shown only when the source is selected or
    // under the pointer so that a scene of several sources is not a scene of
    // several sources plus a dozen dots.
    if (isHovered || this.isSelected()) {
      for (const end of [this.p1, this.p2]) {
        canvasRenderer.drawPoint(
          end,
          isHovered ? this.scene.highlightColor : this.scene.theme.sourcePoint.color,
          this.scene.theme.sourcePoint.size
        );
      }
    }
  }

  onConstructMouseDown(mouse, ctrl, shift) {
    super.onConstructMouseDown(mouse, ctrl, shift);
  }

  /**
   * Sample the line into point sources.
   *
   * @param {Object} context
   * @param {Object} context.settings - Resolved wave settings.
   * @param {number} context.samplesPerWavelength - Effective sampling density.
   * @returns {Array<{x: number, y: number, re: number, im: number}>}
   */
  getWaveSources({ settings, samplesPerWavelength }) {
    this.error = null;
    if (!this.p1 || !this.p2) return [];

    const length = geometry.segmentLength(this);
    if (!(length > 0) || !Number.isFinite(length)) return [];
    if (!(this.amplitude > 0)) return [];

    let amplitudeOf;
    let phaseOf;
    try {
      amplitudeOf = evaluateLatex(this.eqnAmplitude);
      phaseOf = evaluateLatex(this.eqnPhase);
    } catch (e) {
      this.error = e.toString();
      return [];
    }

    const lambda = settings?.wavelength > 0 ? settings.wavelength : 20;
    const count = this.sampleCount(settings, samplesPerWavelength, length);
    const step = length / count;
    const dirX = (this.p2.x - this.p1.x) / length;
    const dirY = (this.p2.y - this.p1.y) / length;
    const centerX = (this.p1.x + this.p2.x) / 2;
    const centerY = (this.p1.y + this.p2.y) / 2;

    const sources = [];
    for (let i = 0; i < count; i++) {
      // Sample at cell centres, so u is symmetric about zero at the midpoint.
      const u = -length / 2 + (i + 0.5) * step;

      let localAmplitude;
      let localPhase;
      try {
        // `lambda` is bound to the scene's wavelength, so a phase ramp can be
        // written in terms of it and keep meaning the same angle when the
        // wavelength changes.
        localAmplitude = amplitudeOf({ u, lambda });
        localPhase = phaseOf({ u, lambda });
      } catch (e) {
        this.error = e.toString();
        return [];
      }
      if (!Number.isFinite(localAmplitude) || !Number.isFinite(localPhase)) continue;

      // `step` is the arc length this sample stands for; it makes the emitted
      // field independent of the sampling density.
      const weight = this.amplitude * localAmplitude * step;
      sources.push({
        x: centerX + dirX * u,
        y: centerY + dirY * u,
        re: weight * Math.cos(localPhase),
        im: weight * Math.sin(localPhase)
      });
    }
    return sources;
  }

  /**
   * How many samples this line needs at a given density.
   *
   * Used by the scene model to size the total sampling budget before any
   * sampling is done.
   *
   * @param {Object} settings - Resolved wave settings.
   * @param {number} samplesPerWavelength
   * @param {number} [length] - Precomputed segment length.
   * @returns {number}
   */
  sampleCount(settings, samplesPerWavelength, length = null) {
    const span = length ?? geometry.segmentLength(this);
    if (!(span > 0) || !Number.isFinite(span)) return 0;
    const mediumWavelength = wavelengthInMedium(
      settings.wavelength, settings.refractiveIndex
    );
    return Math.max(1, Math.ceil(span * samplesPerWavelength / mediumWavelength));
  }

  /** @returns {number} The number of wave sources this object wants. */
  getWaveSourceCount(context) {
    if (!this.p1 || !this.p2 || !(this.amplitude > 0)) return 0;
    return this.sampleCount(context.settings, context.samplesPerWavelength);
  }

  scale(scale, center) {
    super.scale(scale, center);
    // The amplitude is per unit length, so it dilutes as the line grows.
    this.amplitude /= scale;
    return true;
  }

  getError() {
    return this.error;
  }

  /** Wave objects take no part in ray tracing. */
  checkRayIntersects(ray) {
    return null;
  }
}

export default WaveLineSource;
