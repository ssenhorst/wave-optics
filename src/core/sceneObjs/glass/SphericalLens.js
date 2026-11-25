/*
 * Copyright 2024 The Ray Optics Simulation authors and contributors
 * Modified in the Wave Optics Simulation, a fork of https://github.com/ricktu288/ray-optics
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

import Glass from './Glass.js';
import BaseGlass from '../BaseGlass.js';
import geometry from '../../geometry.js';
import i18next from 'i18next';
import { drawOpticalAxis, drawFocalPoints } from '../opticalAxisDecoration.js';

/**
 * Spherical lens.
 * 
 * Tools -> Glass -> Spherical Lens
 * 
 * It is essentially a special case of `sceneObjs['Glass']` that has the shape of a lens, but it provides a more user-friendly interface to create a lens using more familliar parameters.
 * In the state where the lens is built, it behaves exactly like `sceneObjs['Glass']`, and `p1`, `p2`, and `parames` are null. But when the lens is not built (which happens when the user enters a set of invalid parameters, or if the JSON data is defined using parameters directly), it is defined using `p1`, `p2`, and `params`, and `path` is null.
 * @class
 * @extends sceneObjs.Glass
 * @memberof sceneObjs
 * @property {Array<object>} path - The path of the lens if it is built.
 * @property {string} defBy - The way the lens is defined. Either 'DR1R2' (thickness and radii of curvature), 'DFfdBfd' (thickness and front/back focal distances), or 'DF' (thickness and effective focal length, giving a symmetric lens).
 * @property {Point} p1 - The intersection of the perpendicular bisector of the segment for the `d` parameter with the top edge of the lens, if it is not built.
 * @property {Point} p2 - The intersection of the perpendicular bisector of the segment for the `d` parameter with the bottom edge of the lens, if it is not built.
 * @property {object} params - The parameters of the lens if it is not built. It has the following properties: `d`, `r1`, and `r2` if `defBy` is 'DR1R2', `d`, `ffd`, and `bfd` if `defBy` is 'DFfdBfd', and `d` and `f` if `defBy` is 'DF'.
 * @property {boolean} showOpticalAxis - Whether the optical axis of the lens is drawn as a reference.
 * @property {boolean} showFocalPoints - Whether the focal points of the lens are drawn as a reference, rather than only while the lens is hovered.
 * @property {number} refIndex - The refractive index of the glass, or the Cauchy coefficient A of the glass if "Simulate Colors" is on.
 * @property {number} cauchyB - The Cauchy coefficient B of the glass if "Simulate Colors" is on, in micrometer squared.
 */
/**
 * What a lens's power is multiplied by to report it, chosen so that an ordinary lens in a scene
 * drawn at this size reads as a small number. On a scene in millimetres it is the dioptre.
 * @const {number}
 */
const POWER_SCALE = 1000;

class SphericalLens extends Glass {
  static type = 'SphericalLens';
  static isOptical = true;
  static mergesWithGlass = true;
  static serializableDefaults = {
    path: null,
    defBy: 'DR1R2',
    p1: null,
    p2: null,
    params: null,
    refIndex: 1.5,
    cauchyB: 0.004,
    partialReflect: true,
    showOpticalAxis: false,
    showFocalPoints: false
  };

  static getDescription(objData, scene, detailed = false) {
    return i18next.t('main:tools.SphericalLens.title');
  }

  /**
   * The focal length, as a property that can be set.
   *
   * A lens held as a shape has no focal length stored anywhere — it is a consequence of the radii —
   * but an exercise about how strongly each element focuses needs it as a single number the student
   * can turn. Reading it recomputes it from the shape; writing it rebuilds the lens at the same
   * thickness and the same bending, so that turning this one number changes only what it names.
   * @type {number}
   */
  get focalLength() {
    return this.getDFX().f;
  }

  set focalLength(value) {
    const current = this.getDFX();
    this.createLensWithDFX(current.d, value, current.x);
  }

  /**
   * How strongly the lens focuses, as its power rather than its focal length.
   *
   * Focal length is the wrong number to put in front of a beginner. It runs the wrong way — a
   * stronger lens has a *smaller* focal length — and two lenses in contact do not add up in it,
   * where their powers simply do. An exercise about sharing the focusing between several lenses is
   * unreadable in focal lengths and obvious in powers, so this is what the sliders show.
   *
   * It is scaled by a thousand, so that a lens of a few hundred units of focal length reads as a
   * small number of units of power rather than as 0.0034. On a scene drawn in millimetres that
   * scaling makes it the dioptre.
   * @type {number}
   */
  get power() {
    const f = this.getDFX().f;
    return isFinite(f) && f !== 0 ? POWER_SCALE / f : 0;
  }

  set power(value) {
    const current = this.getDFX();
    // A lens of no power is a flat plate, which has no focal length to be given. A very long one
    // stands in for it: the slider then runs smoothly through zero instead of breaking there.
    const focalLength = Math.abs(value) < 1e-6 ? 1e7 : POWER_SCALE / value;
    this.createLensWithDFX(current.d, focalLength, current.x);
  }

  /**
   * How the lens is bent at a fixed focal length; see {@link createLensWithDFX}.
   * @type {number}
   */
  get shapeFactor() {
    return this.getDFX().x;
  }

  set shapeFactor(value) {
    const current = this.getDFX();
    this.createLensWithDFX(current.d, current.f, value);
  }

  static getPropertySchema(objData, scene) {
    if (objData.defBy === 'DFX') {
      // Given by its power and its bending, the lens is edited as those two numbers rather than as
      // six points on a path the student never thinks in.
      return [
        { key: 'power', type: 'number', label: i18next.t('simulator:sceneObjs.SphericalLens.power') },
        { key: 'shapeFactor', type: 'number', label: i18next.t('simulator:sceneObjs.SphericalLens.shapeFactor') },
        ...BaseGlass.getPropertySchema(objData, scene),
        { key: 'showOpticalAxis', type: 'boolean', label: i18next.t('simulator:sceneObjs.common.showOpticalAxis') },
        { key: 'showFocalPoints', type: 'boolean', label: i18next.t('simulator:sceneObjs.common.showFocalPoints') },
      ];
    }
    return [
      { key: 'path.0', type: 'point', label: i18next.t('simulator:sceneObjs.common.pointN', { i: 1 }) },
      { key: 'path.1', type: 'point', label: i18next.t('simulator:sceneObjs.common.pointN', { i: 2 }) },
      { key: 'path.2', type: 'point', label: i18next.t('simulator:sceneObjs.common.pointN', { i: 3 }) },
      { key: 'path.3', type: 'point', label: i18next.t('simulator:sceneObjs.common.pointN', { i: 4 }) },
      { key: 'path.4', type: 'point', label: i18next.t('simulator:sceneObjs.common.pointN', { i: 5 }) },
      { key: 'path.5', type: 'point', label: i18next.t('simulator:sceneObjs.common.pointN', { i: 6 }) },
      ...BaseGlass.getPropertySchema(objData, scene),
      { key: 'showOpticalAxis', type: 'boolean', label: i18next.t('simulator:sceneObjs.common.showOpticalAxis') },
      { key: 'showFocalPoints', type: 'boolean', label: i18next.t('simulator:sceneObjs.common.showFocalPoints') },
    ];
  }

  constructor(scene, jsonObj) {
    super(scene, jsonObj);

    if (!this.path && this.p1 && this.p2) {
      // If the lens is not built in the JSON data, build the lens here.
      if (this.defBy == 'DR1R2') {
        this.createLensWithDR1R2(this.params.d, this.params.r1, this.params.r2);
      } else if (this.defBy == 'DFfdBfd') {
        this.createLensWithDFfdBfd(this.params.d, this.params.ffd, this.params.bfd);
      } else if (this.defBy == 'DF') {
        this.createLensWithDF(this.params.d, this.params.f);
      } else if (this.defBy == 'DFX') {
        this.createLensWithDFX(this.params.d, this.params.f, this.params.x);
      }
    }
  }

  populateObjBar(objBar) {
    objBar.setTitle(i18next.t('main:tools.SphericalLens.title'));
    objBar.createDropdown('', this.defBy, {
      'DR1R2': i18next.t('simulator:sceneObjs.SphericalLens.defBy.radiiOfCurvature'),
      'DFfdBfd': i18next.t('simulator:sceneObjs.SphericalLens.defBy.focalDistances'),
      'DF': i18next.t('simulator:sceneObjs.SphericalLens.defBy.focalLength'),
      'DFX': i18next.t('simulator:sceneObjs.SphericalLens.defBy.focalLengthAndShape')
    }, function (obj, value) {
      obj.defBy = value;
    }, null, true);

    if (this.defBy == 'DR1R2') {
      var params = this.getDR1R2();
      var r1 = params.r1;
      var r2 = params.r2;
      var d = params.d;

      objBar.createNumber('R<sub>1</sub>', 0, 100, 1, r1, function (obj, value) {
        var params = obj.getDR1R2();
        var r2 = params.r2;
        var d = params.d;
        obj.createLensWithDR1R2(d, value, r2);
      }, null, true);
      objBar.createNumber('R<sub>2</sub>', 0, 100, 1, r2, function (obj, value) {
        var params = obj.getDR1R2();
        var r1 = params.r1;
        var d = params.d;
        obj.createLensWithDR1R2(d, r1, value);
      }, null, true);
      objBar.createNumber('d', 0, 100, 1, d, function (obj, value) {
        var params = obj.getDR1R2();
        var r1 = params.r1;
        var r2 = params.r2;
        obj.createLensWithDR1R2(value, r1, r2);
      }, null, true);
    } else if (this.defBy == 'DF') {
      var params = this.getDF();

      objBar.createNumber(i18next.t('simulator:sceneObjs.common.focalLength'), -1000, 1000, 1, params.f, function (obj, value) {
        obj.createLensWithDF(obj.getDF().d, value);
      }, i18next.t('simulator:sceneObjs.common.lengthUnitInfo'), true);
      objBar.createNumber('d', 0, 100, 1, params.d, function (obj, value) {
        obj.createLensWithDF(value, obj.getDF().f);
      }, null, true);
    } else if (this.defBy == 'DFX') {
      var params = this.getDFX();

      objBar.createNumber(i18next.t('simulator:sceneObjs.SphericalLens.power'), -20, 20, 0.05, this.power, function (obj, value) {
        obj.power = value;
      }, i18next.t('simulator:sceneObjs.SphericalLens.powerInfo'), true);
      objBar.createNumber(i18next.t('simulator:sceneObjs.SphericalLens.shapeFactor'), -3, 3, 0.05, params.x, function (obj, value) {
        const current = obj.getDFX();
        obj.createLensWithDFX(current.d, current.f, value);
      }, i18next.t('simulator:sceneObjs.SphericalLens.shapeFactorInfo'), true);
      objBar.createNumber('d', 0, 100, 1, params.d, function (obj, value) {
        const current = obj.getDFX();
        obj.createLensWithDFX(value, current.f, current.x);
      }, null, true);
    } else if (this.defBy == 'DFfdBfd') {
      objBar.createInfoBox('<img src="../img/FFD_BFD.svg" width=100%>');

      var params = this.getDFfdBfd();
      var d = params.d;
      var ffd = params.ffd;
      var bfd = params.bfd;

      objBar.createNumber('FFD', 0, 100, 1, ffd, function (obj, value) {
        var params = obj.getDFfdBfd();
        var d = params.d;
        var bfd = params.bfd;
        obj.createLensWithDFfdBfd(d, value, bfd);
      }, null, true);
      objBar.createNumber('BFD', 0, 100, 1, bfd, function (obj, value) {
        var params = obj.getDFfdBfd();
        var d = params.d;
        var ffd = params.ffd;
        obj.createLensWithDFfdBfd(d, ffd, value);
      }, null, true);
      objBar.createNumber('d', 0, 100, 1, d, function (obj, value) {
        var params = obj.getDFfdBfd();
        var ffd = params.ffd;
        var bfd = params.bfd;
        obj.createLensWithDFfdBfd(value, ffd, bfd);
      }, null, true);
    }

    if (this.scene.simulateColors) {
      objBar.createNumber(i18next.t('simulator:sceneObjs.BaseGlass.cauchyCoeff') + " A", 1, 3, 0.01, this.refIndex, function (obj, value) {
        var old_params = obj.getDFfdBfd();
        obj.refIndex = value * 1;
        if (obj.defBy == 'DFfdBfd') {
          // If the lens is defined by d,ffd,bfd, we need to rebuild the lens with the new refractive index so that the focal distances are correct.
          obj.createLensWithDFfdBfd(old_params.d, old_params.ffd, old_params.bfd);
        }
      }, '<p>*' + i18next.t('simulator:sceneObjs.BaseGlass.refIndexInfo.relative') + '</p><p>' + i18next.t('simulator:sceneObjs.BaseGlass.refIndexInfo.effective') + '</p>');
      objBar.createNumber("B(μm²)", 0.0001, 0.02, 0.0001, this.cauchyB, function (obj, value) {
        var old_params = obj.getDFfdBfd();
        obj.cauchyB = value;
        if (obj.defBy == 'DFfdBfd') {
          // If the lens is defined by d,ffd,bfd, we need to rebuild the lens with the new refractive index so that the focal distances are correct.
          obj.createLensWithDFfdBfd(old_params.d, old_params.ffd, old_params.bfd);
        }
      });
    } else {
      objBar.createNumber(i18next.t('simulator:sceneObjs.BaseGlass.refIndex') + '*', 0.5, 2.5, 0.01, this.refIndex, function (obj, value) {
        var old_params = obj.getDFfdBfd();
        obj.refIndex = value * 1;
        if (obj.defBy == 'DFfdBfd') {
          // If the lens is defined by d,ffd,bfd, we need to rebuild the lens with the new refractive index so that the focal distances are correct.
          obj.createLensWithDFfdBfd(old_params.d, old_params.ffd, old_params.bfd);
        }
      }, '<p>*' + i18next.t('simulator:sceneObjs.BaseGlass.refIndexInfo.relative') + '</p><p>' + i18next.t('simulator:sceneObjs.BaseGlass.refIndexInfo.effective') + '</p>');
    }

    if (objBar.showAdvanced(!this.arePropertiesDefault(['partialReflect']))) {
      objBar.createBoolean(i18next.t('simulator:sceneObjs.BaseGlass.partialReflect'), this.partialReflect, function (obj, value) {
        obj.partialReflect = value;
      });
    }
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    const ctx = canvasRenderer.ctx;
    const ls = canvasRenderer.lengthScale;

    if (this.p1 && this.p2 && this.p1.x == this.p2.x && this.p1.y == this.p2.y) {
      ctx.fillStyle = 'rgb(128,128,128)';
      ctx.fillRect(this.p1.x - 1.5 * ls, this.p1.y - 1.5 * ls, 3 * ls, 3 * ls);
      return;
    }

    if (!this.path) {
      if (this.p1 && this.p2) {
        ctx.fillStyle = 'rgb(255,0,0)';
        ctx.fillRect(this.p1.x - 1.5 * ls, this.p1.y - 1.5 * ls, 3 * ls, 3 * ls);
        ctx.fillRect(this.p2.x - 1.5 * ls, this.p2.y - 1.5 * ls, 3 * ls, 3 * ls);
      }
      return;
    }
    super.draw(canvasRenderer, isAboveLight, isHovered);

    var p1 = geometry.midpoint(this.path[0], this.path[1]);
    var p2 = geometry.midpoint(this.path[3], this.path[4]);
    var len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    var dx = (p2.x - p1.x) / len;
    var dy = (p2.y - p1.y) / len;
    var dpx = dy;
    var dpy = -dx;

    this.drawOpticalDecorations(canvasRenderer);

    if (isHovered && !this.showFocalPoints) {
      // Draw the focal points, which when the lens is defined by its focal length are also the
      // handles for dragging it.
      drawFocalPoints(canvasRenderer, this.scene, this.getFocalPoints());
    }
  }

  /**
   * The centre of the lens and the unit vector along its optical axis.
   * @returns {{center: Point, direction: Point}|null} The axis, or null if the lens is not built.
   */
  getOpticalAxis() {
    if (!this.path) return null;
    const p1 = geometry.midpoint(this.path[0], this.path[1]);
    const p2 = geometry.midpoint(this.path[3], this.path[4]);
    const len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    if (!(len > 0)) return null;
    return {
      center: geometry.midpoint(this.path[2], this.path[5]),
      direction: geometry.point((p2.y - p1.y) / len, -(p2.x - p1.x) / len),
    };
  }

  /**
   * The focal points of the lens, measured from its vertices by the front and back focal distances,
   * which is where a student would find them by experiment.
   * @returns {Array<Point>} The back focal point then the front one, or an empty array if the lens is
   * not built or has no finite focal length.
   */
  getFocalPoints() {
    const axis = this.getOpticalAxis();
    // `getDFfdBfd` reports the stored parameters when the lens could not be built, which are not
    // focal distances, so there is nothing to draw in that case.
    if (!axis || this.params) return [];
    const { ffd, bfd } = this.getDFfdBfd();
    if (!isFinite(ffd) || !isFinite(bfd)) return [];
    const d = axis.direction;
    return [
      geometry.point(this.path[2].x + bfd * d.x, this.path[2].y + bfd * d.y),
      geometry.point(this.path[5].x - ffd * d.x, this.path[5].y - ffd * d.y),
    ];
  }

  getInteractionHandles() {
    const handles = super.getInteractionHandles();
    if (this.defBy === 'DF') {
      this.getFocalPoints().forEach((point, i) => {
        handles.push({ point, propertyKey: 'focalLength', part: 3 + i });
      });
    }
    return handles;
  }

  /**
   * Draw the reference marks the scene asked for: the optical axis through the lens and its focal
   * points.
   * @param {CanvasRenderer} canvasRenderer - The renderer.
   */
  drawOpticalDecorations(canvasRenderer) {
    const axis = this.getOpticalAxis();
    if (!axis) return;
    if (this.showOpticalAxis) {
      drawOpticalAxis(canvasRenderer, this.scene, axis.center, axis.direction);
    }
    if (this.showFocalPoints) {
      drawFocalPoints(canvasRenderer, this.scene, this.getFocalPoints());
    }
  }

  getDefaultCenter() {
    // While the lens is held as parameters rather than as a shape (the user has asked for something
    // that cannot be built), there is no path for the inherited implementation to average.
    if (!this.path) {
      return this.p1 && this.p2 ? geometry.midpoint(this.p1, this.p2) : null;
    }
    return super.getDefaultCenter();
  }

  move(diffX, diffY) {
    if (this.path) {
      super.move(diffX, diffY);
    } else if (this.p1 && this.p2) {
      this.p1.x += diffX;
      this.p1.y += diffY;
      this.p2.x += diffX;
      this.p2.y += diffY;
    }
    return true;
  }

  rotate(angle, center = null) {
    if (this.path) {
      return super.rotate(angle, center);
    }
    return false;
  }

  scale(scale, center = null) {
    if (this.path) {
      return super.scale(scale, center);
    }
    return false;
  }

  onConstructMouseDown(mouse, ctrl, shift) {
    if (!this.constructionPoint) {
      // Initialize the construction stage.
      this.constructionPoint = mouse.getPosSnappedToGrid();
      this.p1 = this.constructionPoint;
      this.p2 = this.constructionPoint;
      this.path = null;
      this.params = null;
    }
    if (shift) {
      this.p2 = mouse.getPosSnappedToDirection(this.constructionPoint, [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 }]);
    } else {
      this.p2 = mouse.getPosSnappedToGrid();
    }

    this.createLens();

    return {
      requiresObjBarUpdate: true
    }
  }

  onConstructMouseMove(mouse, ctrl, shift) {
    if (shift) {
      this.p2 = mouse.getPosSnappedToDirection(this.constructionPoint, [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 }]);
    } else {
      this.p2 = mouse.getPosSnappedToGrid();
    }

    this.p1 = ctrl ? geometry.point(2 * this.constructionPoint.x - this.p2.x, 2 * this.constructionPoint.y - this.p2.y) : this.constructionPoint;

    this.createLens();

    return {
      requiresObjBarUpdate: true
    }
  }

  onConstructMouseUp(mouse, ctrl, shift) {
    if (!mouse.snapsOnPoint(this.p1)) {
      this.p1 = null;
      this.p2 = null;
      this.params = null;
      delete this.constructionPoint;
      return {
        isDone: true,
        requiresObjBarUpdate: true
      };
    }
  }
  
  onConstructUndo() {
    return {
      isCancelled: true
    }
  }

  checkMouseOver(mouse) {
    let dragContext = {};
    if (!this.path) {
      if (this.p1 && this.p2) {
        if (mouse.isOnPoint(this.p1)) {
          dragContext.part = -1;
          dragContext.targetPoint = this.p1;
          return dragContext;
        }
        if (mouse.isOnPoint(this.p2)) {
          dragContext.part = -1;
          dragContext.targetPoint = this.p2;
          return dragContext;
        }
      }
      return null;
    };
    if (this.defBy === 'DF') {
      // The focal points double as handles for the focal length, so that a lens can be adjusted
      // directly on the canvas rather than only through a number.
      const focalPoints = this.getFocalPoints();
      for (let i = 0; i < focalPoints.length; i++) {
        if (mouse.isOnPoint(focalPoints[i])) {
          return {
            part: 3 + i,
            targetPoint_: geometry.point(focalPoints[i].x, focalPoints[i].y),
            propertyKey: 'focalLength',
            requiresObjBarUpdate: true,
            cursor: 'pointer',
          };
        }
      }
    }

    dragContext = super.checkMouseOver(mouse);
    if (dragContext) {
      if (dragContext.part != 0) {
        dragContext.requiresObjBarUpdate = true;
      }
      
      return dragContext;
    }
  }

  onDrag(mouse, dragContext, ctrl, shift) {
    if (dragContext.part === 3 || dragContext.part === 4) {
      // Dragging a focal point sets the focal length to the distance from the matching vertex, which
      // is what the back and front focal distances mean.
      const axis = this.getOpticalAxis();
      if (!axis) return;
      const vertex = dragContext.part === 3 ? this.path[2] : this.path[5];
      const sign = dragContext.part === 3 ? 1 : -1;
      const pos = mouse.getPosSnappedToGrid();
      const focalDistance = sign * ((pos.x - vertex.x) * axis.direction.x + (pos.y - vertex.y) * axis.direction.y);

      // Close to the lens the focal length is shorter than any lens of this aperture can have, so
      // the build fails. Keep the last shape that worked rather than leaving a lens that cannot be
      // drawn or grabbed any more; the drag then simply pauses while the handle crosses the lens and
      // picks up again with the opposite sign on the other side.
      const snapshot = this.captureShape();
      this.setFocalDistance(this.getDF().d, focalDistance, dragContext.part === 3);
      if (!this.path) {
        this.restoreShape(snapshot);
      }
      return;
    }
    if (dragContext.part == -1) return;
    var p1 = geometry.midpoint(this.path[0], this.path[1]);
    var p2 = geometry.midpoint(this.path[3], this.path[4]);
    var len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    var dx = (p2.x - p1.x) / len;
    var dy = (p2.y - p1.y) / len;
    var dpx = dy;
    var dpy = -dx;
    var cx = (p1.x + p2.x) * .5;
    var cy = (p1.y + p2.y) * .5;
    var othick = Math.hypot(this.path[0].x - p1.x, this.path[0].y - p1.y);
    var cthick2 = Math.hypot(this.path[2].x - cx, this.path[2].y - cy);
    var cthick5 = Math.hypot(this.path[5].x - cx, this.path[5].y - cy);
    var oldx, oldy;
    if (dragContext.part == 1) {
      oldx = this.path[dragContext.index].x;
      oldy = this.path[dragContext.index].y;
    }

    super.onDrag(mouse, dragContext, ctrl, shift);

    if (dragContext.isByHandle) return;
    if (dragContext.part != 1)
      return;
    const mousePos = mouse.getPosSnappedToGrid();
    if (dragContext.index == 2 || dragContext.index == 5) {
      // keep center points on optical axis
      var off = (mousePos.x - cx) * dpx + (mousePos.y - cy) * dpy;
      this.path[dragContext.index] = { x: cx + dpx * off, y: cy + dpy * off, arc: true };
    } else {
      var thick = Math.abs(((mousePos.x - cx) * dpx + (mousePos.y - cy) * dpy));
      // adjust center thickness to match so curvature is the same
      cthick2 += thick - othick;
      cthick5 += thick - othick;
      var mpt = this.path[dragContext.index];
      var lchange = (mpt.x - oldx) * dx + (mpt.y - oldy) * dy;
      // adjust length
      if (dragContext.index < 2) {
        p1.x += lchange * dx;
        p1.y += lchange * dy;
      } else {
        p2.x += lchange * dx;
        p2.y += lchange * dy;
      }

      len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      dx = (p2.x - p1.x) / len;
      dy = (p2.y - p1.y) / len;
      dpx = dy;
      dpy = -dx;
      cx = (p1.x + p2.x) * .5;
      cy = (p1.y + p2.y) * .5;

      // recreate lens
      this.path[0] = { x: p1.x - dpx * thick, y: p1.y - dpy * thick, arc: false };
      this.path[1] = { x: p1.x + dpx * thick, y: p1.y + dpy * thick, arc: false };
      this.path[2] = { x: cx + dpx * cthick2, y: cy + dpy * cthick2, arc: true };
      this.path[3] = { x: p2.x + dpx * thick, y: p2.y + dpy * thick, arc: false };
      this.path[4] = { x: p2.x - dpx * thick, y: p2.y - dpy * thick, arc: false };
      this.path[5] = { x: cx - dpx * cthick5, y: cy - dpy * cthick5, arc: true };
    }
  }

  checkRayIntersects(ray) {
    if (!this.path) return false;
    return super.checkRayIntersects(ray);
  }

  getPrimitives() {
    return this.path ? super.getPrimitives() : [];
  }

  /* Utility methods */


  createLens() {
    var p1 = this.p1 || geometry.midpoint(this.path[0], this.path[1]);
    var p2 = this.p2 || geometry.midpoint(this.path[3], this.path[4]);
    var len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    var dx = (p2.x - p1.x) / len;
    var dy = (p2.y - p1.y) / len;
    var dpx = dy;
    var dpy = -dx;
    var cx = (p1.x + p2.x) * .5;
    var cy = (p1.y + p2.y) * .5;
    const thick = 10 * this.scene.lengthScale;
    // create lens
    if (!this.path) this.path = [];
    this.path[0] = { x: p1.x - dpx * thick, y: p1.y - dpy * thick, arc: false };
    this.path[1] = { x: p1.x + dpx * thick, y: p1.y + dpy * thick, arc: false };
    this.path[2] = { x: cx + dpx * thick * 2, y: cy + dpy * thick * 2, arc: true };
    this.path[3] = { x: p2.x + dpx * thick, y: p2.y + dpy * thick, arc: false };
    this.path[4] = { x: p2.x - dpx * thick, y: p2.y - dpy * thick, arc: false };
    this.path[5] = { x: cx - dpx * thick * 2, y: cy - dpy * thick * 2, arc: true };
  }

  createLensWithDR1R2(d, r1, r2) {
    this.error = null;

    if (!this.path) {
      var p1 = this.p1;
      var p2 = this.p2;
    } else {
      var old_params = this.getDR1R2();
      var p1 = geometry.midpoint(this.path[0], this.path[1]);
      var p2 = geometry.midpoint(this.path[3], this.path[4]);
      var old_d = old_params.d;
      var old_r1 = old_params.r1;
      var old_r2 = old_params.r2;
      var old_length = Math.hypot(p1.x - p2.x, p1.y - p2.y);

      if (old_r1 < Infinity && old_r1 > -Infinity) {
        var old_curveShift1 = old_r1 - Math.sqrt(old_r1 * old_r1 - old_length * old_length / 4) * Math.sign(old_r1);
      } else {
        var old_curveShift1 = 0;
      }

      if (old_r2 < Infinity && old_r2 > -Infinity) {
        var old_curveShift2 = old_r2 - Math.sqrt(old_r2 * old_r2 - old_length * old_length / 4) * Math.sign(old_r2);
      } else {
        var old_curveShift2 = 0;
      }

      var old_edgeShift1 = old_d / 2 - old_curveShift1;
      var old_edgeShift2 = old_d / 2 + old_curveShift2;
    }

    var len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    var dx = (p2.x - p1.x) / len;
    var dy = (p2.y - p1.y) / len;
    var dpx = dy;
    var dpy = -dx;

    if (old_params) {
      // Correct p1 and p2 so that this.path[2] and this.path[5] will move symmetrically from the old lens.
      var correction = (old_edgeShift1 - old_edgeShift2) / 2;
      p1.x += dpx * correction;
      p1.y += dpy * correction;
      p2.x += dpx * correction;
      p2.y += dpy * correction;
    }



    var cx = (p1.x + p2.x) * .5;
    var cy = (p1.y + p2.y) * .5;


    if (r1 < Infinity && r1 > -Infinity) {
      var curveShift1 = r1 - Math.sqrt(r1 * r1 - len * len / 4) * Math.sign(r1);
    } else {
      var curveShift1 = 0;
    }

    if (r2 < Infinity && r2 > -Infinity) {
      var curveShift2 = r2 - Math.sqrt(r2 * r2 - len * len / 4) * Math.sign(r2);
    } else {
      var curveShift2 = 0;
    }

    var edgeShift1 = d / 2 - curveShift1;
    var edgeShift2 = d / 2 + curveShift2;

    //console.log([edgeShift1,edgeShift2,d])

    if (isNaN(curveShift1) || isNaN(curveShift2)) {
      // invalid lens. Store the parameters so we can restore them later.
      this.p1 = p1;
      this.p2 = p2;
      this.path = null;
      this.params = { r1: r1, r2: r2, d: d };
      this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
    } else {
      // create lens
      if (!this.path) this.path = [];
      this.path[0] = { x: p1.x - dpx * edgeShift1, y: p1.y - dpy * edgeShift1, arc: false };
      this.path[1] = { x: p1.x + dpx * edgeShift2, y: p1.y + dpy * edgeShift2, arc: false };
      this.path[2] = { x: cx + dpx * (d / 2), y: cy + dpy * (d / 2), arc: true };
      this.path[3] = { x: p2.x + dpx * edgeShift2, y: p2.y + dpy * edgeShift2, arc: false };
      this.path[4] = { x: p2.x - dpx * edgeShift1, y: p2.y - dpy * edgeShift1, arc: false };
      this.path[5] = { x: cx - dpx * (d / 2), y: cy - dpy * (d / 2), arc: true };
      if (this.p1) {
        this.p1 = null;
        this.p2 = null;
      }
      if (this.params) this.params = null;
    }
  }

  /**
   * Build a symmetric lens of a given centre thickness and effective focal length.
   *
   * A focal length does not determine a lens on its own, so the lens is taken to be symmetric
   * (r1 = -r2 = R), which is the shape a student pictures when given only a focal length. R follows
   * from the thick-lens maker's equation
   *
   *     1/f = (n - 1) (2/R - (n - 1) d / (n R^2))
   *
   * which is a quadratic in 1/R; the root that tends to the thin-lens value R = 2(n - 1)f as the
   * thickness goes to zero is the one taken. A negative focal length gives a negative R, that is a
   * symmetric diverging lens.
   * @param {number} d - The centre thickness.
   * @param {number} f - The effective focal length. Negative for a diverging lens.
   */
  /**
   * Build the lens from its focusing power and its shape, holding the two apart.
   *
   * A lens of a given focal length can be ground to many shapes — equiconvex, plano-convex either
   * way round, or a meniscus — and which one it is changes its aberration completely while leaving
   * its focal length untouched. The two radii do not separate those two facts: moving either of them
   * changes both at once, which makes a lens impossible to reason about by turning one number at a
   * time. The *shape factor* `x = (r2 + r1) / (r2 - r1)` is the standard way to hold them apart. It
   * is 0 for an equiconvex lens, +1 and -1 for the two plano-convex orientations, and beyond those
   * the lens becomes a meniscus.
   *
   * In terms of the curvatures a = 1/r1 and b = 1/r2 the shape factor is simply `(a + b) / (a - b)`,
   * so writing `s = a - b` gives `a = s(x + 1)/2` and `b = s(x - 1)/2`, and the thick-lens maker's
   * equation becomes a quadratic in `s` that this solves exactly.
   * @param {number} d - The centre thickness.
   * @param {number} f - The effective focal length.
   * @param {number} x - The shape factor.
   */
  createLensWithDFX(d, f, x) {
    this.error = null;
    this.defBy = 'DFX';

    const n = this.getRefIndexAt(null, { wavelength: 546 });
    const power = (isFinite(f) && f !== 0) ? 1 / f : NaN;

    let s = NaN;
    if (isFinite(power)) {
      const quadratic = (n - 1) * (n - 1) * d * (x * x - 1) / (4 * n);
      const linear = n - 1;
      if (Math.abs(quadratic) < 1e-14) {
        s = power / linear;
      } else {
        const discriminant = linear * linear + 4 * quadratic * power;
        if (discriminant >= 0) {
          // The root that tends to the thin-lens answer as the thickness goes to zero.
          const root = (-linear + Math.sqrt(discriminant)) / (2 * quadratic);
          const other = (-linear - Math.sqrt(discriminant)) / (2 * quadratic);
          const thin = power / linear;
          s = Math.abs(root - thin) <= Math.abs(other - thin) ? root : other;
        }
      }
    }

    if (!isFinite(s) || s === 0) {
      this.storeUnbuiltParams({ d: d, f: f, x: x });
      return;
    }

    const a = s * (x + 1) / 2;
    const b = s * (x - 1) / 2;
    const r1 = Math.abs(a) < 1e-14 ? Infinity : 1 / a;
    const r2 = Math.abs(b) < 1e-14 ? Infinity : 1 / b;

    this.createLensWithDR1R2(d, r1, r2);
    if (!this.path) {
      this.storeUnbuiltParams({ d: d, f: f, x: x });
      return;
    }
    this.defBy = 'DFX';
    this.warning = this.describeThicknessWarning(d, r1, r2);
  }

  /**
   * The thickness, focal length and shape factor of the lens as it stands.
   * @returns {{d: number, f: number, x: number}} The parameters.
   */
  getDFX() {
    if (this.params && 'x' in this.params) return this.params;

    const { d, r1, r2 } = this.getDR1R2();
    const a = isFinite(r1) ? 1 / r1 : 0;
    const b = isFinite(r2) ? 1 / r2 : 0;
    const difference = a - b;
    return {
      d,
      f: this.getFocalLength(),
      x: Math.abs(difference) < 1e-14 ? 0 : (a + b) / difference,
    };
  }

  /**
   * Keep a set of parameters that could not be built, so that the user can edit their way back out
   * of an impossible lens rather than losing what they typed.
   * @param {Object} params - The parameters.
   */
  storeUnbuiltParams(params) {
    if (this.path) {
      this.p1 = geometry.midpoint(this.path[0], this.path[1]);
      this.p2 = geometry.midpoint(this.path[3], this.path[4]);
      this.path = null;
    }
    this.params = params;
    this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
  }

  /**
   * Whether the two surfaces would meet before the rim, which builds a shape whose edges cross over.
   * @param {number} d - The centre thickness.
   * @param {number} r1 - The first radius.
   * @param {number} r2 - The second radius.
   * @returns {string|null} The warning, or null if the lens is buildable.
   */
  describeThicknessWarning(d, r1, r2) {
    if (!this.path) return null;
    const p1 = geometry.midpoint(this.path[0], this.path[1]);
    const p2 = geometry.midpoint(this.path[3], this.path[4]);
    const halfAperture = Math.hypot(p1.x - p2.x, p1.y - p2.y) / 2;
    const sagitta = (r) => (isFinite(r)
      ? Math.abs(r) - Math.sqrt(Math.max(0, r * r - halfAperture * halfAperture))
      : 0);
    const needed = Math.max(0, sagitta(r1)) + Math.max(0, sagitta(r2));
    return d < needed
      ? i18next.t('simulator:sceneObjs.SphericalLens.thicknessTooSmall')
      : null;
  }

  createLensWithDF(d, f) {
    this.error = null;
    this.defBy = 'DF';

    const n = this.getRefIndexAt(null, { wavelength: 546 });
    const a = (n - 1) * (n - 1) * d / n;
    let r;

    if (!isFinite(f) || f === 0) {
      r = NaN;
    } else if (Math.abs(a) < 1e-12) {
      r = 2 * (n - 1) * f;
    } else {
      const discriminant = (n - 1) * (n - 1) - a / f;
      if (discriminant < 0) {
        r = NaN;
      } else {
        r = a / ((n - 1) - Math.sqrt(discriminant));
      }
    }

    if (isNaN(r)) {
      // The focal length cannot be reached at this thickness. Keep the parameters so the user can
      // enter another pair, exactly as the other definitions do.
      if (this.path) {
        const p1 = geometry.midpoint(this.path[0], this.path[1]);
        const p2 = geometry.midpoint(this.path[3], this.path[4]);
        this.p1 = p1;
        this.p2 = p2;
        this.path = null;
      }
      this.params = { d: d, f: f };
      this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
      return;
    }

    this.createLensWithDR1R2(d, r, -r);
    if (!this.path) {
      this.params = { d: d, f: f };
      this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
      return;
    }

    // A focal length short enough for the aperture makes the two surfaces meet before the rim, which
    // builds a shape whose edges cross over. The lens still traces rays, but not as the lens the user
    // asked for, so say so rather than letting it look correct.
    const p1 = geometry.midpoint(this.path[0], this.path[1]);
    const p2 = geometry.midpoint(this.path[3], this.path[4]);
    const halfAperture = Math.hypot(p1.x - p2.x, p1.y - p2.y) / 2;
    const sagitta = Math.abs(r) - Math.sqrt(Math.max(0, r * r - halfAperture * halfAperture));
    this.warning = (d / 2 < sagitta)
      ? i18next.t('simulator:sceneObjs.SphericalLens.thicknessTooSmall')
      : null;
  }

  /**
   * A copy of everything that defines the current shape of the lens, for undoing a failed rebuild.
   * @returns {Object} The snapshot.
   */
  captureShape() {
    return {
      path: this.path ? JSON.parse(JSON.stringify(this.path)) : null,
      params: this.params ? { ...this.params } : null,
      p1: this.p1 ? { ...this.p1 } : null,
      p2: this.p2 ? { ...this.p2 } : null,
      error: this.error,
      warning: this.warning,
    };
  }

  /**
   * Put back a shape captured by {@link captureShape}.
   * @param {Object} snapshot - The snapshot.
   */
  restoreShape(snapshot) {
    this.path = snapshot.path;
    this.params = snapshot.params;
    this.p1 = snapshot.p1;
    this.p2 = snapshot.p2;
    this.error = snapshot.error;
    this.warning = snapshot.warning;
  }

  /**
   * Rebuild the lens so that the focal point sits a given distance from its vertex.
   *
   * The handle the user drags is a focal *distance* from a vertex, while the property that defines
   * the lens is its effective focal length. For a thick lens the two differ by a factor that itself
   * depends on the curvature, so the focal length is refined a few times until the focal point lands
   * where the user put it rather than a little short of it.
   * @param {number} d - The centre thickness to keep.
   * @param {number} focalDistance - The distance from the vertex to the focal point.
   * @param {boolean} isBack - Whether the back focal distance is the one being set.
   */
  setFocalDistance(d, focalDistance, isBack) {
    const n = this.getRefIndexAt(null, { wavelength: 546 });
    const { r1 } = this.getDR1R2();
    const slope = isFinite(r1) && r1 !== 0 ? 1 - (n - 1) * d / (n * r1) : 1;
    let f = Math.abs(slope) < 1e-9 ? focalDistance : focalDistance / slope;

    for (let i = 0; i < 4; i++) {
      this.createLensWithDF(d, f);
      if (this.error || !this.path) return;
      const achieved = isBack ? this.getDFfdBfd().bfd : this.getDFfdBfd().ffd;
      const error = achieved - focalDistance;
      if (!isFinite(error) || Math.abs(error) < 1e-9) return;
      const step = Math.abs(slope) < 1e-9 ? error : error / slope;
      f -= step;
    }
  }

  /**
   * The centre thickness and effective focal length of the lens.
   * @returns {{d: number, f: number}} The parameters.
   */
  getDF() {
    if (this.params) {
      if ('f' in this.params) return this.params;
      const fallback = this.getDR1R2();
      return { d: fallback.d, f: this.getFocalLength() };
    }
    return { d: this.getDR1R2().d, f: this.getFocalLength() };
  }

  /**
   * The effective focal length of the lens, from the thick-lens maker's equation.
   * @returns {number} The focal length, or Infinity if the lens has no power.
   */
  getFocalLength() {
    const { d, r1, r2 } = this.getDR1R2();
    const n = this.getRefIndexAt(null, { wavelength: 546 });
    return 1 / ((n - 1) * (1 / r1 - 1 / r2 + (n - 1) * d / (n * r1 * r2)));
  }

  /**
   * @property {number} focalLength - The effective focal length of the lens. Setting it rebuilds the
   * lens as a symmetric one of the same thickness. The name matches that of the ideal elements, so
   * that a scene's interaction permissions and a UI control can address it the same way whichever
   * kind of lens it is.
   */
  get focalLength() {
    return this.getFocalLength();
  }

  set focalLength(value) {
    this.createLensWithDF(this.getDF().d, value);
  }

  createLensWithDFfdBfd(d, ffd, bfd) {
    this.error = null;

    if (!this.path) {
      var p1 = this.p1;
      var p2 = this.p2;
    } else {
      var old_params = this.getDR1R2();
      var p1 = geometry.midpoint(this.path[0], this.path[1]);
      var p2 = geometry.midpoint(this.path[3], this.path[4]);
      var old_d = old_params.d;
      var old_r1 = old_params.r1;
      var old_r2 = old_params.r2;
      var old_length = Math.hypot(p1.x - p2.x, p1.y - p2.y);

      if (old_r1 < Infinity && old_r1 > -Infinity) {
        var old_curveShift1 = old_r1 - Math.sqrt(old_r1 * old_r1 - old_length * old_length / 4) * Math.sign(old_r1);
      } else {
        var old_curveShift1 = 0;
      }

      if (old_r2 < Infinity && old_r2 > -Infinity) {
        var old_curveShift2 = old_r2 - Math.sqrt(old_r2 * old_r2 - old_length * old_length / 4) * Math.sign(old_r2);
      } else {
        var old_curveShift2 = 0;
      }

      var old_edgeShift1 = old_d / 2 - old_curveShift1;
      var old_edgeShift2 = old_d / 2 + old_curveShift2;
    }

    var len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    var dx = (p2.x - p1.x) / len;
    var dy = (p2.y - p1.y) / len;
    var dpx = dy;
    var dpy = -dx;

    if (old_params) {
      // Correct p1 and p2 so that this.path[2] and this.path[5] will move symmetrically from the old lens.
      var correction = (old_edgeShift1 - old_edgeShift2) / 2;
      p1.x += dpx * correction;
      p1.y += dpy * correction;
      p2.x += dpx * correction;
      p2.y += dpy * correction;
    }

    var n = this.getRefIndexAt(null, {wavelength: 546});

    // Solve for r1 and r2

    var r1_1 = (d * (-1 + n) * (d + 2 * ffd * n - Math.sqrt(d ** 2 + 4 * bfd * ffd * n ** 2))) / (2 * n * (d + (-bfd + ffd) * n));
    var r2_1 = -(d * (-1 + n) * (d + 2 * bfd * n - Math.sqrt(d ** 2 + 4 * bfd * ffd * n ** 2))) / (2 * n * (d + (bfd - ffd) * n));

    var r1_2 = (d * (-1 + n) * (d + 2 * ffd * n + Math.sqrt(d ** 2 + 4 * bfd * ffd * n ** 2))) / (2 * n * (d + (-bfd + ffd) * n));
    var r2_2 = -(d * (-1 + n) * (d + 2 * bfd * n + Math.sqrt(d ** 2 + 4 * bfd * ffd * n ** 2))) / (2 * n * (d + (bfd - ffd) * n));

    

    if (!isNaN(r1_1) && !isNaN(r2_1) && (isNaN(r1_2) || isNaN(r2_2))) {
      // If only the first solution is valid, use that.
      var r1 = r1_1;
      var r2 = r2_1;
      this.createLensWithDR1R2(d, r1, r2);
      if (!this.path) {
        // If the lens is invalid as defined by d,r1,r2, still store the d,ffl,bfl parameters instead so the user may enter another set of d,ffl,bfl to get a valid lens.
        this.params = { d: d, ffd: ffd, bfd: bfd };
        this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
      }
    } else if (!isNaN(r1_2) && !isNaN(r2_2) && (isNaN(r1_1) || isNaN(r2_1))) {
      // If only the second solution is valid, use that.
      var r1 = r1_2;
      var r2 = r2_2;
      this.createLensWithDR1R2(d, r1, r2);
      if (!this.path) {
        // If the lens is invalid as defined by d,r1,r2, still store the d,ffl,bfl parameters instead so the user may enter another set of d,ffl,bfl to get a valid lens.
        this.params = { d: d, ffd: ffd, bfd: bfd };
        this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
      }
    } else if (!isNaN(r1_1) && !isNaN(r2_1) && !isNaN(r1_2) && !isNaN(r2_2)) {
      // If both solutions are valid, and if the old lens is valid, prefer the solution that is closest to the old lens.
      if (old_params) {
        var old_r1_1_diff = Math.abs(old_r1 - r1_1);
        var old_r2_1_diff = Math.abs(old_r2 - r2_1);
        var old_r1_2_diff = Math.abs(old_r1 - r1_2);
        var old_r2_2_diff = Math.abs(old_r2 - r2_2);

        if (old_r1_1_diff + old_r2_1_diff < old_r1_2_diff + old_r2_2_diff) {
          var r1_a = r1_1;
          var r2_a = r2_1;
          var r1_b = r1_2;
          var r2_b = r2_2;
        } else {
          var r1_a = r1_2;
          var r2_a = r2_2;
          var r1_b = r1_1;
          var r2_b = r2_1;
        }
      } else {
        // If the old lens is invalid, prefer the solution with the smaller radius of curvature.
        if (Math.abs(r1_1) + Math.abs(r2_1) < Math.abs(r1_2) + Math.abs(r2_2)) {
          var r1_a = r1_1;
          var r2_a = r2_1;
          var r1_b = r1_2;
          var r2_b = r2_2;
        } else {
          var r1_a = r1_2;
          var r2_a = r2_2;
          var r1_b = r1_1;
          var r2_b = r2_1;
        }
      }

      // Try the preferred solution first.
      var r1 = r1_a;
      var r2 = r2_a;
      this.createLensWithDR1R2(d, r1, r2);
      if (!this.path) {
        // Try the other solution if the preferred solution gives an invalid set of d,r1,r2.
        r1 = r1_b;
        r2 = r2_b;
        this.createLensWithDR1R2(d, r1, r2);
        if (!this.path) {
          // If the lens is still invalid, still store the d,ffl,bfl parameters instead so the user may enter another set of d,ffl,bfl to get a valid lens.
          this.params = { d: d, ffd: ffd, bfd: bfd };
          this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
        }
      }
    } else {
      // invalid lens. Store the parameters so we can restore them later.
      this.p1 = p1;
      this.p2 = p2;
      this.path = null;
      this.params = { d: d, ffd: ffd, bfd: bfd };
      this.error = i18next.t('simulator:sceneObjs.SphericalLens.invalidParameters');
      return;
    }
  }

  getDR1R2() {
    if (this.params) return this.params;

    // get radii of curvature
    var center1 = geometry.linesIntersection(geometry.perpendicularBisector(geometry.line(this.path[1], this.path[2])),
      geometry.perpendicularBisector(geometry.line(this.path[3], this.path[2])));
    var r2 = geometry.distance(center1, this.path[2]);
    var center2 = geometry.linesIntersection(geometry.perpendicularBisector(geometry.line(this.path[4], this.path[5])),
      geometry.perpendicularBisector(geometry.line(this.path[0], this.path[5])));
    var r1 = geometry.distance(center2, this.path[5]);

    var p1 = geometry.midpoint(this.path[0], this.path[1]);
    var p2 = geometry.midpoint(this.path[3], this.path[4]);
    var len = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    var dx = (p2.x - p1.x) / len;
    var dy = (p2.y - p1.y) / len;
    var dpx = dy;
    var dpy = -dx;
    var cx = (p1.x + p2.x) * .5;
    var cy = (p1.y + p2.y) * .5;
    var d = geometry.distance(this.path[2], this.path[5]);

    // correct sign
    if (dpx * (center1.x - this.path[2].x) + dpy * (center1.y - this.path[2].y) < 0)
      r2 = -r2;
    if (dpx * (center2.x - this.path[5].x) + dpy * (center2.y - this.path[5].y) < 0)
      r1 = -r1;

    if (isNaN(r1)) {
      r1 = Infinity;
    }
    if (isNaN(r2)) {
      r2 = Infinity;
    }
    return { d: d, r1: r1, r2: r2 };
  }

  getDFfdBfd() {
    if (this.params) return this.params;

    var dR1R2 = this.getDR1R2();
    var r1 = dR1R2.r1;
    var r2 = dR1R2.r2;
    var d = dR1R2.d;
    var n = this.getRefIndexAt(null, {wavelength: 546});

    var f = 1 / ((n - 1) * (1 / r1 - 1 / r2 + (n - 1) * d / (n * r1 * r2)));
    var ffd = f * (1 + (n - 1) * d / (n * r2));
    var bfd = f * (1 - (n - 1) * d / (n * r1));

    return { d: d, ffd: ffd, bfd: bfd };
  }
};

export default SphericalLens;
