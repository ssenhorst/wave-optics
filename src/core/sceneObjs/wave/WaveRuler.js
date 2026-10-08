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

import Ruler from '../other/Ruler.js';
import i18next from 'i18next';

/** A ruler drawn above the opaque wave-field canvas. */
class WaveRuler extends Ruler {
  static type = 'WaveRuler';
  static serializableDefaults = {
    ...Ruler.serializableDefaults,
    wavelengthUnits: false,
  };

  static getPropertySchema(objData, scene) {
    return [
      ...super.getPropertySchema(objData, scene),
      {
        key: 'wavelengthUnits', type: 'boolean',
        label: i18next.t('simulator:waveSceneObjs.common.unitsWavelengths'),
      },
    ];
  }

  populateObjBar(objBar) {
    super.populateObjBar(objBar);
    objBar.createBoolean(
      i18next.t('simulator:waveSceneObjs.common.unitsWavelengths'),
      this.wavelengthUnits,
      (obj, value) => { obj.wavelengthUnits = value; }
    );
  }

  formatScaleLabel(distance) {
    if (!this.wavelengthUnits) return distance;
    const wavelength = this.scene?.waveOptics?.wavelength;
    if (!(Number.isFinite(wavelength) && wavelength > 0)) return distance;
    const value = Number((distance / wavelength).toFixed(2));
    return `${value} λ`;
  }

  draw(canvasRenderer, isAboveLight, isHovered) {
    if (isAboveLight) super.draw(canvasRenderer, false, isHovered);
  }
}

export default WaveRuler;