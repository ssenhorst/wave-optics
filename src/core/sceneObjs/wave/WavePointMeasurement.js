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
import geometry from '../../geometry.js';
import i18next from 'i18next';
import { collectInterfaces } from '../../waveOptics/waveSceneModel.js';
import { fieldAt, fieldSerial, drawLabel, MEASURE_COLOR, VIRTUAL_COLOR } from './waveMeasurement.js';

const FAR_FIELD_FRESNEL_MARGIN = 60;

/** Read the complex field at one point, optionally in an outgoing direction. */
class WavePointMeasurement extends BaseSceneObj {
  static type = 'WavePointMeasurement';
  static isOptical = false;
  static serializableDefaults = {
    x: null,
    y: null,
    farField: false,
  };

  static getDescription() {
    return i18next.t('main:waveTools.WavePointMeasurement.title');
  }

  static getPropertySchema() {
    return [
      { key: '', type: 'point', label: i18next.t('simulator:waveSceneObjs.common.probePoint') },
      {
        key: 'farField', type: 'boolean',
        label: i18next.t('simulator:waveSceneObjs.common.farField'),
      },
    ];
  }

  populateObjBar(objBar) {
    objBar.setTitle(i18next.t('main:waveTools.WavePointMeasurement.title'));
    objBar.createBoolean(
      i18next.t('simulator:waveSceneObjs.common.farField'),
      this.farField,
      (obj, value) => { obj.farField = value; },
      '<p>' + i18next.t('simulator:waveSceneObjs.common.pointFarFieldInfo') + '</p>'
    );
  }

  /** Where the field is evaluated, and the direction marker to draw. */
  samplingPoint() {
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) return null;
    const point = { x: this.x, y: this.y };
    if (!this.farField) return { point, origin: null };

    const axisSign = this.scene?.waveOptics?.reversed ? -1 : 1;
    const surfaces = collectInterfaces(this.scene, axisSign);
    let surface = null;
    for (const candidate of surfaces) {
      if (axisSign * candidate.meanZ() <= axisSign * point.x) surface = candidate;
      else break;
    }
    if (!surface) return null;

    const extent = surface.getExtent();
    const originY = (extent.yMin + extent.yMax) / 2;
    const origin = {
      x: surface.zAt(originY),
      y: originY,
    };
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const distance = Math.hypot(dx, dy);
    if (!(distance > 0)) return null;

    const wavelength = this.scene?.waveOptics?.wavelength || 20;
    const halfWidth = (extent.yMax - extent.yMin) / 2;
    const aperture = 2 * Math.max(halfWidth, wavelength);
    const radius = Math.max(
      FAR_FIELD_FRESNEL_MARGIN * aperture * aperture / wavelength,
      1000 * aperture
    );
    return {
      point: {
        x: origin.x + dx / distance * radius,
        y: origin.y + dy / distance * radius,
      },
      origin,
    };
  }

  measure() {
    const serial = fieldSerial(this.scene);
    const key = JSON.stringify([serial, this.x, this.y, this.farField]);
    if (this._cache?.key === key) return this._cache.result;

    const sample = this.samplingPoint();
    const field = sample ? fieldAt(this.scene, [sample.point]) : null;
    let result = null;
    if (field) {
      const real = field[0];
      const imaginary = field[1];
      const amplitude = Math.hypot(real, imaginary);
      result = {
        amplitude,
        intensity: amplitude * amplitude,
        phase: amplitude > 0 ? Math.atan2(imaginary, real) : null,
      };
    }
    this._cache = { key, result };
    return result;
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    if (!isAboveLight || !Number.isFinite(this.x) || !Number.isFinite(this.y)) return;

    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;
    const color = isHovered
      ? this.scene.highlightColorCss
      : (this.farField ? VIRTUAL_COLOR : MEASURE_COLOR);
    const sample = this.samplingPoint();

    if (this.farField && sample?.origin) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = ls;
      ctx.setLineDash([4 * ls, 4 * ls]);
      ctx.beginPath();
      ctx.moveTo(sample.origin.x, sample.origin.y);
      ctx.lineTo(this.x, this.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 3 * ls;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.beginPath();
    ctx.arc(this.x, this.y, 5 * ls, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5 * ls;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();

    const result = this.measure();
    if (!result) {
      drawLabel(
        canvasRenderer,
        i18next.t('simulator:waveSceneObjs.common.probeNoField'),
        { x: this.x + 10 * ls, y: this.y - 6 * ls },
        { color }
      );
      return;
    }

    const lines = [
      i18next.t('simulator:waveSceneObjs.common.pointAmplitude', {
        value: result.amplitude.toPrecision(4),
      }),
      i18next.t('simulator:waveSceneObjs.common.pointIntensity', {
        value: result.intensity.toPrecision(4),
      }),
      i18next.t('simulator:waveSceneObjs.common.pointPhase', {
        value: result.phase === null ? 'undefined' : result.phase.toFixed(3),
      }),
    ];
    drawLabel(canvasRenderer, lines, { x: this.x + 10 * ls, y: this.y - 6 * ls }, { color });
  }

  move(diffX, diffY) {
    this.x += diffX;
    this.y += diffY;
    return true;
  }

  rotate(angle, center = null) {
    center = center || this.getDefaultCenter();
    const dx = this.x - center.x;
    const dy = this.y - center.y;
    this.x = center.x + dx * Math.cos(angle) - dy * Math.sin(angle);
    this.y = center.y + dx * Math.sin(angle) + dy * Math.cos(angle);
    return true;
  }

  scale(scale, center = null) {
    center = center || this.getDefaultCenter();
    this.x = center.x + (this.x - center.x) * scale;
    this.y = center.y + (this.y - center.y) * scale;
    return true;
  }

  getDefaultCenter() {
    return { x: this.x, y: this.y };
  }

  onConstructMouseDown(mouse) {
    const point = mouse.getPosSnappedToGrid();
    this.x = point.x;
    this.y = point.y;
  }

  onConstructMouseUp() {
    return { isDone: true };
  }

  checkMouseOver(mouse) {
    if (mouse.isOnPoint(this)) {
      return {
        part: 0,
        targetPoint: geometry.point(this.x, this.y),
        snapContext: {},
      };
    }
  }

  onDrag(mouse) {
    const point = mouse.getPosSnappedToGrid();
    this.x = point.x;
    this.y = point.y;
  }

  checkRayIntersects() {
    return null;
  }
}

export default WavePointMeasurement;