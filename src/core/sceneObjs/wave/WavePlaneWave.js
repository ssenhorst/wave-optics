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
import { drawHandle, drawGuide, isOnHandle } from './waveHandles.js';

/**
 * How far along the direction of travel the angle control sits, in scene units.
 *
 * It is a fixed scene distance rather than a fixed screen distance so that the
 * control stays put relative to the wave it is steering when the view is
 * zoomed, which is what makes it feel attached to the object.
 */
const DIRECTION_HANDLE_DISTANCE = 60;

/** The largest angle from the axis a plane wave may be given, in degrees. */
const MAX_ANGLE = 89;

/**
 * A plane wave filling the subspace it sits in.
 *
 * It is evaluated in closed form, `A e^{i phi} e^{i k d . (p - r)}`, rather than
 * built from a row of point sources. A finite row would carry the diffraction
 * of its own aperture, which is exactly the artefact one wants to be rid of
 * when studying what an optical element does to an ideal input.
 *
 * The anchor point sets where the stated phase applies and, more importantly,
 * which subspace the wave belongs to. Like everything else here, it stops at
 * the next interface, which samples it and re-radiates it onwards.
 *
 * Tools -> Sources -> Plane wave
 * @class
 * @extends BaseSceneObj
 * @memberof sceneObjs
 * @property {number} x - The x coordinate of the anchor point.
 * @property {number} y - The y coordinate of the anchor point.
 * @property {number} amplitude - The amplitude of the wave.
 * @property {number} phase - The phase at the anchor point, in degrees.
 * @property {number} angle - The propagation direction, in degrees from the optical axis.
 */
class WavePlaneWave extends BaseSceneObj {
  static type = 'WavePlaneWave';
  static isOptical = true;
  static serializableDefaults = {
    x: null,
    y: null,
    amplitude: 1,
    phase: 0,
    angle: 0,
    ...SIGNAL_DEFAULTS
  };

  static getDescription(objData, scene, detailed = false) {
    return i18next.t('main:waveTools.WavePlaneWave.title');
  }

  static getPropertySchema(objData, scene) {
    return [
      { key: '', type: 'point', label: i18next.t('simulator:waveSceneObjs.common.anchorPoint') },
      { key: 'amplitude', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.amplitude') },
      { key: 'angle', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.angle') + ' (°)' },
      { key: 'phase', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.phase') + ' (°)' },
      ...signalPropertySchema(),
    ];
  }

  populateObjBar(objBar) {
    objBar.setTitle(i18next.t('main:waveTools.WavePlaneWave.title'));
    objBar.createNumber(
      i18next.t('simulator:waveSceneObjs.common.amplitude'), 0, 5, 0.01, this.amplitude,
      function (obj, value) { obj.amplitude = value; }
    );
    objBar.createNumber(
      i18next.t('simulator:waveSceneObjs.common.angle') + ' (°)', -89, 89, 1, this.angle,
      function (obj, value) { obj.angle = value; },
      '<p>' + i18next.t('simulator:waveSceneObjs.common.angleInfo') + '</p>'
    );
    objBar.createNumber(
      i18next.t('simulator:waveSceneObjs.common.phase') + ' (°)', -180, 180, 1, this.phase,
      function (obj, value) { obj.phase = value; },
      '<p>' + i18next.t('simulator:waveSceneObjs.common.anchorPhaseInfo') + '</p>'
    );
    populateSignalObjBar(objBar, this);
  }

  /**
   * The unit propagation direction.
   *
   * The angle is measured from the optical axis, not from the canvas, so a
   * scene running right to left aims its plane waves that way without every
   * angle in it needing to be rewritten.
   */
  direction() {
    const radians = this.angle * Math.PI / 180;
    const axisSign = this.scene?.waveOptics?.reversed ? -1 : 1;
    return { x: axisSign * Math.cos(radians), y: Math.sin(radians) };
  }

  /**
   * Where the control that aims the wave sits: out along the direction of
   * travel, at the tip of the arrow that already shows that direction.
   * @returns {{x: number, y: number}}
   */
  directionHandlePoint() {
    const direction = this.direction();
    return {
      x: this.x + direction.x * DIRECTION_HANDLE_DISTANCE,
      y: this.y + direction.y * DIRECTION_HANDLE_DISTANCE,
    };
  }

  /**
   * The angle a point off the anchor implies, clamped to the half space the
   * model can carry.
   *
   * The field is summed forward only, so a wave aimed backwards would simply
   * not exist; the control stops at grazing instead of allowing that.
   *
   * @param {{x: number, y: number}} point
   * @returns {number} Degrees.
   */
  angleTowards(point) {
    const axisSign = this.scene?.waveOptics?.reversed ? -1 : 1;
    const degrees = Math.atan2(
      point.y - this.y, axisSign * (point.x - this.x)
    ) * 180 / Math.PI;
    return Math.min(MAX_ANGLE, Math.max(-MAX_ANGLE, degrees));
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    if (!isAboveLight) return;

    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;
    const color = isHovered
      ? this.scene.highlightColorCss
      : canvasRenderer.rgbaToCssColor(this.scene.theme.lightSource.color);
    const direction = this.direction();
    const normal = { x: -direction.y, y: direction.x };

    // A few wavefront ticks across the direction of travel, plus an arrow, so
    // the orientation reads at a glance without implying a finite aperture.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * ls;
    ctx.setLineDash([]);
    const half = 22 * ls;
    for (let i = -1; i <= 1; i++) {
      const offset = i * 9 * ls;
      ctx.beginPath();
      ctx.moveTo(
        this.x + direction.x * offset - normal.x * half,
        this.y + direction.y * offset - normal.y * half
      );
      ctx.lineTo(
        this.x + direction.x * offset + normal.x * half,
        this.y + direction.y * offset + normal.y * half
      );
      ctx.stroke();
    }

    const tip = 34 * ls;
    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(this.x + direction.x * tip, this.y + direction.y * tip);
    ctx.moveTo(this.x + direction.x * tip, this.y + direction.y * tip);
    ctx.lineTo(
      this.x + direction.x * (tip - 8 * ls) - normal.x * 5 * ls,
      this.y + direction.y * (tip - 8 * ls) - normal.y * 5 * ls
    );
    ctx.moveTo(this.x + direction.x * tip, this.y + direction.y * tip);
    ctx.lineTo(
      this.x + direction.x * (tip - 8 * ls) + normal.x * 5 * ls,
      this.y + direction.y * (tip - 8 * ls) + normal.y * 5 * ls
    );
    ctx.stroke();

    canvasRenderer.drawPoint(
      this,
      isHovered ? this.scene.highlightColor : this.scene.theme.sourcePoint.color,
      this.scene.theme.sourcePoint.size
    );

    // The angle is set by dragging the tip of the arrow, so the tip only
    // becomes a grabbable control once the wave is selected.
    if (this.isSelected()) {
      const handle = this.directionHandlePoint();
      drawGuide(canvasRenderer, this, handle);
      drawHandle(canvasRenderer, handle);
    }
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
    this.angle += angle * 180 / Math.PI;
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

  /**
   * Placing a plane wave is a drag: the press puts the anchor down and the
   * drag aims it, so the direction is chosen at the moment of creation rather
   * than typed in afterwards. Releasing without moving leaves it on the axis,
   * so a plain click still works.
   */
  onConstructMouseDown(mouse, ctrl, shift) {
    const mousePos = mouse.getPosSnappedToGrid();
    this.x = mousePos.x;
    this.y = mousePos.y;
  }

  onConstructMouseMove(mouse, ctrl, shift) {
    const mousePos = mouse.getPosSnappedToGrid();
    if (mousePos.x === this.x && mousePos.y === this.y) return;
    this.angle = Math.round(this.angleTowards(mousePos));
  }

  onConstructMouseUp(mouse, ctrl, shift) {
    return { isDone: true };
  }

  checkMouseOver(mouse) {
    if (this.isSelected() && isOnHandle(mouse, this.directionHandlePoint())) {
      const handle = this.directionHandlePoint();
      return { part: 1, targetPoint: geometry.point(handle.x, handle.y) };
    }
    if (mouse.isOnPoint(this)) {
      return {
        part: 0,
        targetPoint: geometry.point(this.x, this.y),
        snapContext: {}
      };
    }
  }

  onDrag(mouse, dragContext, ctrl, shift) {
    if (dragContext.part === 1) {
      this.angle = this.angleTowards(mouse.pos);
      // Holding shift steps the angle, for setting a round number by hand.
      if (shift) this.angle = Math.round(this.angle / 5) * 5;
      return;
    }
    const mousePos = mouse.getPosSnappedToGrid();
    this.x = mousePos.x;
    this.y = mousePos.y;
  }

  /**
   * The plane waves this object contributes.
   *
   * @returns {Array<{dirX: number, dirY: number, x: number, y: number, re: number, im: number}>}
   */
  getPlaneWaves() {
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) return [];
    if (!(this.amplitude > 0)) return [];

    const phase = this.phase * Math.PI / 180;
    const direction = this.direction();
    return [{
      dirX: direction.x,
      dirY: direction.y,
      x: this.x,
      y: this.y,
      re: this.amplitude * Math.cos(phase),
      im: this.amplitude * Math.sin(phase),
    }];
  }

  /** Wave objects take no part in ray tracing. */
  checkRayIntersects(ray) {
    return null;
  }
}

export default WavePlaneWave;
