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
import { amplitudePhaseColor } from '../../waveOptics/oklch.js';
import { collectInterfaces } from '../../waveOptics/waveSceneModel.js';
import {
  fieldAt, fieldSerial, currentModel, drawLabel, MEASURE_COLOR, VIRTUAL_COLOR
} from './waveMeasurement.js';

/** Points taken across the screen, when not overridden by `sampleCount`. */
const DEFAULT_SAMPLE_COUNT = 257;

/** The fewest and most samples the control allows. */
const MIN_SAMPLE_COUNT = 17;
const MAX_SAMPLE_COUNT = 2049;

/** Height of the plotted curve at full scale, in screen pixels. */
const DEFAULT_PLOT_HEIGHT = 110;

/**
 * How far past the Fraunhofer distance the far field is evaluated.
 *
 * The far field is a limit, so it has to be sampled somewhere finite. Beyond
 * `D^2 / lambda` the pattern has stopped changing shape; this puts the sample
 * well past that, far enough that what comes back is the limit and near enough
 * that the accumulated phase stays comfortably inside double precision.
 */
const FAR_FIELD_FRESNEL_MARGIN = 60;

/** Ticks drawn along the screen. */
const TICK_COUNT = 8;

/**
 * A line the field is read out along, with the readout drawn as a graph.
 *
 * The rendered field answers "what does this look like"; a screen answers "what
 * is it, here". Reading a number off a colour scale is guesswork past the first
 * significant figure, and the intensity view saturates exactly where the
 * interesting structure is, so a slice plotted as a curve is a different
 * instrument rather than a nicer version of the same one.
 *
 * It takes no part in the optics: nothing is blocked, nothing is re-radiated.
 * Putting a detector into a scene should not change the scene.
 *
 * In far-field mode it stops being a place at all. The curve then shows the
 * pattern at infinity, over the angles the screen's own endpoints subtend at its
 * vertex, and is drawn as a dashed arc in a different colour because there is
 * nothing there — the same scene with the screen moved further out would show
 * something else.
 *
 * Tools -> Measure -> Screen
 * @class
 * @extends BaseSceneObj
 * @memberof sceneObjs
 * @property {Point} p1 - One end of the slice.
 * @property {Point} p2 - The other end.
 * @property {Point|null} p3 - The far-field angular-range vertex.
 * @property {string} plotMode - 'intensity', 'real' or 'amplitudePhase'.
 * @property {string} units - 'wavelengths' or 'scene', for the axis.
 * @property {boolean} farField - Show the pattern at infinity instead of here.
 * @property {number} plotHeight - Height of the curve at full scale, in pixels.
 * @property {number} sampleCount - Points taken across the screen.
 * @property {boolean} alwaysShowPlot - Draw the plot even when not selected.
 */
class WaveScreen extends LineObjMixin(BaseSceneObj) {
  static type = 'WaveScreen';
  static isOptical = false;
  static serializableDefaults = {
    p1: null,
    p2: null,
    p3: null,
    plotMode: 'intensity',
    units: 'wavelengths',
    farField: false,
    plotHeight: DEFAULT_PLOT_HEIGHT,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    alwaysShowPlot: false
  };

  static getDescription(objData, scene, detailed = false) {
    return i18next.t('main:waveTools.WaveScreen.title');
  }

  /** The plot modes, as a dropdown's options. */
  static plotModes() {
    return {
      intensity: i18next.t('simulator:waveSceneObjs.common.plotIntensity'),
      real: i18next.t('simulator:waveSceneObjs.common.plotReal'),
      amplitudePhase: i18next.t('simulator:waveSceneObjs.common.plotAmplitudePhase'),
    };
  }

  /** The axis units, as a dropdown's options. */
  static unitOptions() {
    return {
      wavelengths: i18next.t('simulator:waveSceneObjs.common.unitsWavelengths'),
      scene: i18next.t('simulator:waveSceneObjs.common.unitsScene'),
    };
  }

  static getPropertySchema(objData, scene) {
    return [
      ...super.getPropertySchema(objData, scene),
      {
        key: 'p3', type: 'point',
        label: i18next.t('simulator:sceneObjs.ParabolicMirror.vertex'),
      },
      {
        key: 'plotMode', type: 'dropdown',
        label: i18next.t('simulator:waveSceneObjs.common.plotMode'),
        options: WaveScreen.plotModes(),
      },
      {
        key: 'units', type: 'dropdown',
        label: i18next.t('simulator:waveSceneObjs.common.units'),
        options: WaveScreen.unitOptions(),
      },
      { key: 'farField', type: 'boolean', label: i18next.t('simulator:waveSceneObjs.common.farField') },
      { key: 'plotHeight', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.plotHeight') },
      { key: 'sampleCount', type: 'number', label: i18next.t('simulator:waveSceneObjs.common.screenSamples') },
      { key: 'alwaysShowPlot', type: 'boolean', label: i18next.t('simulator:waveSceneObjs.common.alwaysShowPlot') },
    ];
  }

  /**
   * The number of points taken across the screen, clamped to a sane range.
   *
   * Read through this rather than the raw property everywhere a loop bound is
   * needed, so a scene file with a corrupted or missing value degrades to the
   * default instead of producing a zero- or negative-length array.
   * @returns {number}
   */
  samples() {
    const value = Math.round(this.sampleCount);
    if (!Number.isFinite(value)) return DEFAULT_SAMPLE_COUNT;
    return Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, value));
  }

  populateObjBar(objBar) {
    objBar.setTitle(i18next.t('main:waveTools.WaveScreen.title'));
    objBar.createDropdown(
      i18next.t('simulator:waveSceneObjs.common.plotMode'), this.plotMode,
      WaveScreen.plotModes(),
      function (obj, value) { obj.plotMode = value; },
      '<p>' + i18next.t('simulator:waveSceneObjs.common.plotModeInfo') + '</p>',
      true
    );
    objBar.createDropdown(
      i18next.t('simulator:waveSceneObjs.common.units'), this.units,
      WaveScreen.unitOptions(),
      function (obj, value) { obj.units = value; }, null, true
    );
    objBar.createBoolean(
      i18next.t('simulator:waveSceneObjs.common.farField'), this.farField,
      function (obj, value) { obj.farField = value; },
      '<p>' + i18next.t('simulator:waveSceneObjs.common.farFieldInfo') + '</p>'
    );
    objBar.createNumber(
      i18next.t('simulator:waveSceneObjs.common.plotHeight'), 30, 400, 5, this.plotHeight,
      function (obj, value) { obj.plotHeight = value; }
    );
    if (objBar.showAdvanced(!this.arePropertiesDefault(['sampleCount']))) {
      objBar.createNumber(
        i18next.t('simulator:waveSceneObjs.common.screenSamples'),
        MIN_SAMPLE_COUNT, MAX_SAMPLE_COUNT, 2, this.sampleCount,
        function (obj, value) { obj.sampleCount = value; },
        '<p>' + i18next.t('simulator:waveSceneObjs.common.screenSamplesInfo') + '</p>'
      );
    }
    objBar.createBoolean(
      i18next.t('simulator:waveSceneObjs.common.alwaysShowPlot'), this.alwaysShowPlot,
      function (obj, value) { obj.alwaysShowPlot = value; },
      '<p>' + i18next.t('simulator:waveSceneObjs.common.alwaysShowPlotInfo') + '</p>'
    );
  }

  /** @returns {boolean} Whether the slice spans a usable length. */
  isValid() {
    return Boolean(this.p1) && Boolean(this.p2) &&
      (this.p1.x !== this.p2.x || this.p1.y !== this.p2.y);
  }

  onConstructMouseDown(mouse, ctrl, shift) {
    if (this.constructionPoint) return;
    this.constructionPoint = mouse.getPosSnappedToGrid();
    this.p1 = this.constructionPoint;
    this.p2 = this.constructionPoint;
    this.p3 = null;
  }

  onConstructMouseMove(mouse, ctrl, shift) {
    const point = mouse.getPosSnappedToGrid();
    if (this.p3) {
      this.p3 = point;
    } else if (shift) {
      this.p2 = mouse.getPosSnappedToDirection(this.constructionPoint, [
        { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 },
      ]);
      this.p1 = ctrl
        ? { x: 2 * this.constructionPoint.x - this.p2.x, y: 2 * this.constructionPoint.y - this.p2.y }
        : this.constructionPoint;
    } else {
      this.p2 = point;
      this.p1 = ctrl
        ? { x: 2 * this.constructionPoint.x - this.p2.x, y: 2 * this.constructionPoint.y - this.p2.y }
        : this.constructionPoint;
    }
    return { requiresObjBarUpdate: true };
  }

  onConstructMouseUp(mouse) {
    const point = mouse.getPosSnappedToGrid();
    if (!this.p3) {
      this.p2 = point;
      this.p3 = point;
      return { requiresObjBarUpdate: true };
    }
    this.p3 = point;
    if (geometry.distanceSquared(this.p3, this.p1) > 0 &&
      geometry.distanceSquared(this.p3, this.p2) > 0) {
      delete this.constructionPoint;
      return { isDone: true, requiresObjBarUpdate: true };
    }
  }

  /** The midpoint of the slice. */
  center() {
    return { x: (this.p1.x + this.p2.x) / 2, y: (this.p1.y + this.p2.y) / 2 };
  }

  /** The unit vector along the slice, from p1 to p2. */
  tangent() {
    const dx = this.p2.x - this.p1.x;
    const dy = this.p2.y - this.p1.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  }

  /**
   * The unit normal the plot is drawn along.
   *
   * Chosen to point downstream, so a screen across the beam puts its graph on
   * the far side rather than back over the optics it is measuring.
   */
  normal() {
    const tangent = this.tangent();
    const normal = { x: -tangent.y, y: tangent.x };
    return normal.x < 0 ? { x: -normal.x, y: -normal.y } : normal;
  }

  /**
  * The last surface before this screen, used to set the far-field probe radius
  * and as the origin for older screens without an explicit vertex.
   * @returns {Object|null}
   */
  lastSurface() {
    const axisSign = this.scene?.waveOptics?.reversed ? -1 : 1;
    const surfaces = collectInterfaces(this.scene, axisSign);
    const here = axisSign * this.center().x;
    let found = null;
    for (const surface of surfaces) {
      if (axisSign * surface.meanZ() <= here) found = surface; else break;
    }
    return found;
  }

  /** The explicit far-field vertex, or the legacy last-surface centre. */
  farFieldOrigin() {
    const surface = this.lastSurface();
    const extent = surface?.getExtent();
    const halfWidth = extent ? (extent.yMax - extent.yMin) / 2 : 0;
    if (this.p3) return { ...this.p3, halfWidth };
    if (!surface) return null;
    const y = (extent.yMin + extent.yMax) / 2;
    return { x: surface.zAt(y), y, halfWidth };
  }

  /**
   * Where the field is sampled, and where each sample is drawn.
   *
   * For an ordinary screen these are the same points. For a far field they are
   * not: the field is evaluated at a radius far outside the scene, and drawn on
   * an arc where the screen is, so the curve stays beside the optics it belongs
   * to.
   *
   * @returns {{probes: Array<Point>, anchors: Array<Point>, normals: Array<Point>,
   *   axis: Array<number>, axisLabel: string}|null}
   */
  samplePoints() {
    if (!this.isValid()) return null;
    return this.farField ? this.farFieldPoints() : this.slicePoints();
  }

  /** @private */
  slicePoints() {
    const tangent = this.tangent();
    const normal = this.normal();
    const length = Math.hypot(this.p2.x - this.p1.x, this.p2.y - this.p1.y);
    const count = this.samples();
    const probes = [];
    const normals = [];
    const axis = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      probes.push({
        x: this.p1.x + (this.p2.x - this.p1.x) * t,
        y: this.p1.y + (this.p2.y - this.p1.y) * t,
      });
      normals.push(normal);
      // Measured from the centre, so a screen on the axis reads zero there.
      axis.push((t - 0.5) * length);
    }
    return {
      probes, anchors: probes, normals, axis,
      axisLabel: i18next.t('simulator:waveSceneObjs.common.axisPosition'),
      tangent,
    };
  }

  /** @private */
  farFieldPoints() {
    const origin = this.farFieldOrigin();
    if (!origin || geometry.distanceSquared(origin, this.p1) === 0 ||
      geometry.distanceSquared(origin, this.p2) === 0) return null;

    const angleTo = (point) => Math.atan2(point.y - origin.y, point.x - origin.x);
    const from = angleTo(this.p1);
    const to = angleTo(this.p2);
    // The arc is drawn at the screen's own distance, so it replaces the line
    // rather than appearing somewhere unrelated.
    const drawRadius = Math.hypot(this.center().x - origin.x, this.center().y - origin.y);

    const wavelength = this.scene?.waveOptics?.wavelength || 20;
    const aperture = 2 * Math.max(origin.halfWidth, wavelength);
    const probeRadius = Math.max(
      FAR_FIELD_FRESNEL_MARGIN * aperture * aperture / wavelength,
      1000 * aperture
    );

    const count = this.samples();
    const probes = [];
    const anchors = [];
    const normals = [];
    const axis = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const angle = from + (to - from) * t;
      const direction = { x: Math.cos(angle), y: Math.sin(angle) };
      probes.push({
        x: origin.x + direction.x * probeRadius,
        y: origin.y + direction.y * probeRadius,
      });
      anchors.push({
        x: origin.x + direction.x * drawRadius,
        y: origin.y + direction.y * drawRadius,
      });
      // The graph grows outwards from the arc, along the radius.
      normals.push(direction);
      axis.push(angle * 180 / Math.PI);
    }
    return {
      probes, anchors, normals, axis, origin, drawRadius,
      axisLabel: i18next.t('simulator:waveSceneObjs.common.axisAngle'),
      isAngular: true,
    };
  }

  /** This object evaluates the field itself rather than reading the grid. */
  readsField() {
    return false;
  }

  /**
   * Sample the field along the screen, reusing the last result while nothing
   * that would change it has changed.
   *
   * The slice is evaluated on the CPU rather than read off the displayed grid,
   * so it is independent of the display resolution and can be taken at any
   * angle — and so that the far field, which is sampled far outside the view,
   * is possible at all.
   *
   * @returns {Object|null}
   */
  measure() {
    const serial = fieldSerial(this.scene);
    const key = JSON.stringify([
      serial, this.p1, this.p2, this.p3, this.farField, this.plotMode, this.samples(),
    ]);
    if (this._cache?.key === key) return this._cache.result;

    const result = this.computeSamples();
    this._cache = { key, result };
    return result;
  }

  /** @private */
  computeSamples() {
    const layout = this.samplePoints();
    if (!layout || !currentModel(this.scene)) return null;

    const field = fieldAt(this.scene, layout.probes);
    if (!field) return null;

    const count = this.samples();
    const amplitudes = new Float64Array(count);
    const phases = new Float64Array(count);
    let maxAmplitude = 0;
    for (let i = 0; i < count; i++) {
      const re = field[i * 2];
      const im = field[i * 2 + 1];
      amplitudes[i] = Math.hypot(re, im);
      phases[i] = Math.atan2(im, re);
      if (amplitudes[i] > maxAmplitude) maxAmplitude = amplitudes[i];
    }

    // A far field carries a common phase from the radius it was sampled at,
    // which is arbitrary and enormous. Referencing to the middle of the arc
    // removes it, leaving the phase *across* the pattern, which is the part
    // that means anything.
    if (this.farField) {
      const reference = phases[(count - 1) >> 1];
      for (let i = 0; i < count; i++) {
        phases[i] = Math.atan2(
          Math.sin(phases[i] - reference), Math.cos(phases[i] - reference)
        );
      }
    }

    return { layout, amplitudes, phases, maxAmplitude };
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    if (!isAboveLight) return;
    if (!this.isValid()) {
      const ctx = canvasRenderer.ctx;
      ctx.fillStyle = 'rgb(128,128,128)';
      const ls = canvasRenderer.lengthScale;
      ctx.fillRect(this.p1.x - 1.5 * ls, this.p1.y - 1.5 * ls, 3 * ls, 3 * ls);
      return;
    }

    const color = isHovered
      ? this.scene.highlightColorCss
      : (this.farField ? VIRTUAL_COLOR : MEASURE_COLOR);

    this.drawScreenLine(canvasRenderer, color);

    if (this.farField && (isHovered || this.isSelected())) {
      const vertex = this.farFieldOrigin();
      if (vertex) {
        const ctx = canvasRenderer.ctx;
        const ls = canvasRenderer.lengthScale;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = ls;
        ctx.setLineDash([4 * ls, 3 * ls]);
        ctx.beginPath();
        ctx.moveTo(vertex.x, vertex.y);
        ctx.lineTo(this.p1.x, this.p1.y);
        ctx.moveTo(vertex.x, vertex.y);
        ctx.lineTo(this.p2.x, this.p2.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(vertex.x, vertex.y, 5 * ls, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (isHovered || this.isSelected()) {
      for (const end of [this.p1, this.p2]) {
        canvasRenderer.drawPoint(
          end,
          isHovered ? this.scene.highlightColor : this.scene.theme.sourcePoint.color,
          this.scene.theme.sourcePoint.size
        );
      }
    }

    // Selecting the screen is the usual way to bring up its plot, but a scene
    // built to show several at once can pin them all on instead.
    if (this.alwaysShowPlot || this.isSelected()) this.drawPlot(canvasRenderer, color);
  }

  /** The screen itself: a solid line, or a dashed arc for a far field. @private */
  drawScreenLine(canvasRenderer, color) {
    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * ls;

    const layout = this.farField ? this.samplePoints() : null;
    if (layout?.anchors) {
      // Dashed and curved, because the pattern is at infinity: there is nothing
      // in the scene at this arc, and drawing it like a screen would say there
      // was.
      ctx.setLineDash([6 * ls, 5 * ls]);
      ctx.beginPath();
      layout.anchors.forEach((point, i) => {
        if (i === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(this.p1.x, this.p1.y);
      ctx.lineTo(this.p2.x, this.p2.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** @private */
  drawPlot(canvasRenderer, color) {
    const measurement = this.measure();
    if (!measurement) return;

    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;
    const scale = this.scene?.scale || 1;
    // The plot height is in screen pixels, so it stays a readable size at any
    // zoom rather than growing with the scene.
    const height = this.plotHeight / scale;
    const { layout, amplitudes, phases, maxAmplitude } = measurement;
    if (!(maxAmplitude > 0)) return;

    const values = this.plotValues(amplitudes, phases, maxAmplitude);
    const signed = this.plotMode === 'real';

    this.drawPlotFrame(canvasRenderer, layout, height, signed, color);

    const pointAt = (i, value) => ({
      x: layout.anchors[i].x + layout.normals[i].x * value * height,
      y: layout.anchors[i].y + layout.normals[i].y * value * height,
    });

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 2 * ls;
    ctx.lineJoin = 'round';

    const count = this.samples();
    if (this.plotMode === 'amplitudePhase') {
      // The curve is the amplitude and its colour is the phase, so one line
      // carries both without the phase needing an axis of its own.
      const chroma = this.scene?.waveOptics?.phaseChroma ?? 0.18;
      for (let i = 0; i < count - 1; i++) {
        const rgb = amplitudePhaseColor(0.72, (phases[i] + phases[i + 1]) / 2, chroma * 1.6);
        ctx.strokeStyle = `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
        const a = pointAt(i, values[i]);
        const b = pointAt(i + 1, values[i + 1]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const point = pointAt(i, values[i]);
        if (i === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    this.drawPlotLabels(canvasRenderer, layout, height, measurement, color);
  }

  /**
   * The plotted quantity, normalised to the curve's own height.
   * @private
   */
  plotValues(amplitudes, phases, maxAmplitude) {
    const count = this.samples();
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      if (this.plotMode === 'intensity') {
        const normalised = amplitudes[i] / maxAmplitude;
        values[i] = normalised * normalised;
      } else if (this.plotMode === 'real') {
        // Signed, and drawn either side of the screen line.
        values[i] = amplitudes[i] * Math.cos(phases[i]) / maxAmplitude;
      } else {
        values[i] = amplitudes[i] / maxAmplitude;
      }
    }
    return values;
  }

  /** The baseline, the full-scale line, and the ticks along the screen. @private */
  drawPlotFrame(canvasRenderer, layout, height, signed, color) {
    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;
    const at = (i, value) => ({
      x: layout.anchors[i].x + layout.normals[i].x * value * height,
      y: layout.anchors[i].y + layout.normals[i].y * value * height,
    });

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1 * ls;

    // Full scale, and the negative rail when the plot is signed.
    for (const level of signed ? [1, -1] : [1]) {
      ctx.setLineDash([2 * ls, 4 * ls]);
      ctx.beginPath();
      for (let i = 0; i < this.samples(); i++) {
        const point = at(i, level);
        if (i === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }

    // Ticks, hanging off the baseline on the side away from the curve.
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.6;
    for (let t = 0; t <= TICK_COUNT; t++) {
      const i = Math.round(t / TICK_COUNT * (this.samples() - 1));
      const base = at(i, 0);
      const tip = at(i, signed ? -0.06 : -0.04);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
    }
    ctx.restore();

    // The two ends of the axis, in whichever units the screen reports in, so
    // the ticks are a scale rather than decoration.
    for (const i of [0, this.samples() - 1]) {
      const tip = at(i, signed ? -0.16 : -0.13);
      drawLabel(canvasRenderer, this.axisText(layout, i), tip, {
        color, align: 'center', baseline: 'middle', size: 10,
      });
    }
  }

  /**
   * One end of the axis, labelled.
   * @private
   */
  axisText(layout, index) {
    const value = layout.axis[index];
    if (layout.isAngular) return `${value.toFixed(1)}°`;
    const wavelength = this.scene?.waveOptics?.wavelength || 20;
    return this.units === 'wavelengths' && wavelength > 0
      ? `${(value / wavelength).toFixed(1)} λ`
      : value.toFixed(0);
  }

  /** @private */
  drawPlotLabels(canvasRenderer, layout, height, measurement, color) {
    const ls = canvasRenderer.lengthScale;
    const wavelength = this.scene?.waveOptics?.wavelength || 20;
    const last = this.samples() - 1;

    const tip = {
      x: layout.anchors[last].x + layout.normals[last].x * height * 1.05,
      y: layout.anchors[last].y + layout.normals[last].y * height * 1.05,
    };

    const range = layout.isAngular
      ? `${layout.axis[0].toFixed(1)}° … ${layout.axis[last].toFixed(1)}°`
      : this.extentText(layout, wavelength);

    drawLabel(canvasRenderer, [
      i18next.t(`simulator:waveSceneObjs.common.plot${this.plotModeKey()}`),
      `${layout.axisLabel}: ${range}`,
      i18next.t('simulator:waveSceneObjs.common.plotPeak', {
        value: measurement.maxAmplitude.toPrecision(3),
      }),
    ], { x: tip.x + 8 * ls, y: tip.y }, { color });
  }

  /** @private */
  plotModeKey() {
    if (this.plotMode === 'real') return 'Real';
    if (this.plotMode === 'amplitudePhase') return 'AmplitudePhase';
    return 'Intensity';
  }

  /** @private */
  extentText(layout, wavelength) {
    const length = layout.axis[this.samples() - 1] - layout.axis[0];
    return this.units === 'wavelengths' && wavelength > 0
      ? `${(length / wavelength).toFixed(1)} λ`
      : length.toFixed(0);
  }

  checkMouseOver(mouse) {
    if (this.farField && this.isValid()) {
      const vertex = this.farFieldOrigin();
      if (vertex && mouse.isOnPoint(vertex)) {
        return {
          part: 3,
          targetPoint: geometry.point(vertex.x, vertex.y),
        };
      }
    }
    const result = super.checkMouseOver(mouse);
    if (result) return result;
    // A far-field screen is drawn as an arc, so the straight chord it is
    // defined by would otherwise be the only thing grabbable.
    if (this.farField && this.isValid()) {
      const layout = this.samplePoints();
      for (let i = 0; layout && i < layout.anchors.length - 1; i++) {
        if (mouse.isOnSegment(geometry.line(layout.anchors[i], layout.anchors[i + 1]))) {
          const mousePos = mouse.getPosSnappedToGrid();
          return { part: 0, mousePos0: mousePos, mousePos1: mousePos, snapContext: {} };
        }
      }
    }
  }

  move(diffX, diffY) {
    super.move(diffX, diffY);
    if (this.p3) {
      this.p3.x += diffX;
      this.p3.y += diffY;
    }
    return true;
  }

  rotate(angle, center = null) {
    const rotationCenter = center || this.getDefaultCenter();
    super.rotate(angle, rotationCenter);
    if (this.p3) {
      const dx = this.p3.x - rotationCenter.x;
      const dy = this.p3.y - rotationCenter.y;
      this.p3 = {
        x: rotationCenter.x + dx * Math.cos(angle) - dy * Math.sin(angle),
        y: rotationCenter.y + dx * Math.sin(angle) + dy * Math.cos(angle),
      };
    }
    return true;
  }

  scale(scale, center = null) {
    const scalingCenter = center || this.getDefaultCenter();
    super.scale(scale, scalingCenter);
    if (this.p3) {
      this.p3 = {
        x: scalingCenter.x + (this.p3.x - scalingCenter.x) * scale,
        y: scalingCenter.y + (this.p3.y - scalingCenter.y) * scale,
      };
    }
    return true;
  }

  onDrag(mouse, dragContext, ctrl, shift) {
    if (dragContext.part === 3) {
      const point = mouse.getPosSnappedToGrid();
      this.p3 = point;
      return;
    }
    const previousMousePos = dragContext.part === 0 ? dragContext.mousePos1 : null;
    super.onDrag(mouse, dragContext, ctrl, shift);
    if (previousMousePos && this.p3) {
      this.p3.x += dragContext.mousePos1.x - previousMousePos.x;
      this.p3.y += dragContext.mousePos1.y - previousMousePos.y;
    }
  }

  /** Measurements take no part in ray tracing. */
  checkRayIntersects(ray) {
    return null;
  }
}

export default WaveScreen;
