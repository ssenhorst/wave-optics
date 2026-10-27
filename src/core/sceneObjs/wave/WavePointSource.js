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
import { SIGNAL_DEFAULTS } from '../../waveOptics/signals.js';
import { populateSignalObjBar, signalPropertySchema } from './waveSignalControls.js';

/**
 * A time-harmonic point source for the wave-optics simulator: the 2D analogue
 * of a single ray, and the primitive every other wave source is built from.
 *
 * It radiates the outgoing 2D Green's function `A e^{i phi} (i/4) H0(k r)`, so
 * its amplitude falls as `1/sqrt(r)` in the far field rather than the `1/r` of
 * a three-dimensional source.
 *
 * Tools -> Sources -> Point source
 * @class
 * @extends BaseSceneObj
 * @memberof sceneObjs
 * @property {number} x - The x coordinate of the source.
 * @property {number} y - The y coordinate of the source.
 * @property {number} amplitude - The amplitude of the emitted field.
 * @property {number} phase - The phase of the emitted field, in degrees.
 */
class WavePointSource extends BaseSceneObj {
  static type = 'WavePointSource';
  static isOptical = true;
  static serializableDefaults = {
    x: null,
    y: null,
    amplitude: 1,
    phase: 0,
    ...SIGNAL_DEFAULTS
  };

  static getDescription(objData, scene, detailed = false) {
    return i18next.t('main:waveTools.WavePointSource.title');
  }

  static getPropertySchema(objData, scene) {
    return [
      { key: '', type: 'point', label: i18next.t('simulator:sceneObjs.LineObjMixin.sourcePoint') },
      { key: 'amplitude', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.amplitude') },
      { key: 'phase', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.phase') + ' (°)' },
      ...signalPropertySchema(),
    ];
  }

  populateObjBar(objBar) {
    objBar.setTitle(i18next.t('main:waveTools.WavePointSource.title'));
    objBar.createNumber(
      i18next.t('simulator:waveSceneObjs.common.amplitude'), 0, 5, 0.01, this.amplitude,
      function (obj, value) { obj.amplitude = value; }
    );
    objBar.createNumber(
      i18next.t('simulator:waveSceneObjs.common.phase') + ' (°)', -180, 180, 1, this.phase,
      function (obj, value) { obj.phase = value; }
    );
    populateSignalObjBar(objBar, this);
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    // Wave objects are drawn on the layer *above* the field. The field is an
    // opaque image covering the whole canvas, so anything drawn below it would
    // be hidden.
    if (!isAboveLight) return;

    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;
    const color = isHovered
      ? this.scene.highlightColorCss
      : canvasRenderer.rgbaToCssColor(this.scene.theme.lightSource.color);

    // Concentric rings, so the source reads as a radiator rather than as a
    // plain handle. They are decoration only; the field itself is drawn by the
    // wave renderer underneath.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * ls;
    for (let ring = 1; ring <= 2; ring++) {
      ctx.globalAlpha = 0.5 / ring;
      ctx.beginPath();
      ctx.arc(this.x, this.y, ring * 4 * ls, 0, Math.PI * 2, false);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    canvasRenderer.drawPoint(
      this,
      isHovered ? this.scene.highlightColor : this.scene.theme.lightSource.color,
      this.scene.theme.lightSource.size
    );
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
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.x = center.x + dx * cos - dy * sin;
    this.y = center.y + dx * sin + dy * cos;
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

  onConstructMouseDown(mouse, ctrl, shift) {
    const mousePos = mouse.getPosSnappedToGrid();
    this.x = mousePos.x;
    this.y = mousePos.y;
  }

  onConstructMouseUp(mouse, ctrl, shift) {
    return { isDone: true };
  }

  checkMouseOver(mouse) {
    if (mouse.isOnPoint(this)) {
      return {
        part: 0,
        targetPoint: geometry.point(this.x, this.y),
        snapContext: {}
      };
    }
  }

  onDrag(mouse, dragContext, ctrl, shift) {
    const mousePos = mouse.getPosSnappedToGrid();
    this.x = mousePos.x;
    this.y = mousePos.y;
  }

  /**
   * The wave sources this object contributes to the field computation.
   *
   * Returning a list (rather than a single source) is what lets line and area
   * sources share the same interface with this one.
   *
   * @param {Object} context - The wave simulation context.
   * @returns {Array<{x: number, y: number, re: number, im: number}>}
   */
  getWaveSources(context) {
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) return [];
    if (!(this.amplitude > 0)) return [];

    const phase = this.phase * Math.PI / 180;
    return [{
      x: this.x,
      y: this.y,
      re: this.amplitude * Math.cos(phase),
      im: this.amplitude * Math.sin(phase)
    }];
  }

  /** @returns {number} The number of wave sources this object contributes. */
  getWaveSourceCount(context) {
    return this.amplitude > 0 &&
      Number.isFinite(this.x) && Number.isFinite(this.y) ? 1 : 0;
  }

  /**
   * Wave objects do not take part in ray tracing; the ray simulator must not
   * try to intersect them.
   */
  checkRayIntersects(ray) {
    return null;
  }
}

export default WavePointSource;
