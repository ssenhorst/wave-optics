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
 * @file The controls every wave source shares for its time dependence, so the
 * point source, the line source and the plane wave present the signal the same
 * way. See `waveOptics/signals.js` for what the properties mean.
 */

import i18next from 'i18next';
import { SIGNAL_TYPES, MIN_SIGNAL_DURATION } from '../../waveOptics/signals.js';

const t = (key) => i18next.t(`simulator:waveSceneObjs.common.${key}`);

/** The signal types with their display names, in menu order. */
function signalTypeOptions() {
  return Object.fromEntries(SIGNAL_TYPES.map((type) => [type, t(`signalTypes.${type}`)]));
}

/**
 * What the two timing properties are called for each signal type. A continuous
 * wave has neither; noise has no instant of its own, only a coherence time.
 */
function timingLabels(type) {
  switch (type) {
    case 'pulse':
      return { delay: t('pulseCentre'), duration: t('pulseDuration'), durationInfo: t('pulseDurationInfo') };
    case 'switchOn':
      return { delay: t('switchOnTime'), duration: t('riseTime'), durationInfo: t('riseTimeInfo') };
    case 'noise':
      return { delay: null, duration: t('coherenceTime'), durationInfo: t('coherenceTimeInfo') };
    default:
      return null;
  }
}

const cycles = (label) => `${label} (${t('cyclesUnit')})`;

/**
 * Property schema entries for the signal, appended to a source's own.
 * @returns {Array<Object>}
 */
export function signalPropertySchema() {
  return [
    { key: 'signalType', type: 'dropdown', label: t('signal'), options: signalTypeOptions() },
    { key: 'signalDelay', type: 'number', label: cycles(t('signalDelay')) },
    { key: 'signalDuration', type: 'number', label: cycles(t('signalDuration')) },
    { key: 'signalSeed', type: 'number', label: t('noiseSeed') },
  ];
}

/**
 * Add the signal controls to a source's object bar. Only the properties the
 * chosen type uses are shown, so the bar is rebuilt when the type changes.
 * @param {ObjBar} objBar
 * @param {Object} source - A wave source carrying the signal properties.
 */
export function populateSignalObjBar(objBar, source) {
  objBar.createDropdown(
    t('signal'), source.signalType, signalTypeOptions(),
    function (obj, value) { obj.signalType = value; },
    '<p>' + t('signalInfo') + '</p>',
    true
  );

  const labels = timingLabels(source.signalType);
  if (!labels) return;

  if (labels.delay) {
    objBar.createNumber(
      cycles(labels.delay), 0, 200, 0.5, source.signalDelay,
      function (obj, value) { obj.signalDelay = value; },
      '<p>' + t('signalDelayInfo') + '</p>'
    );
  }
  objBar.createNumber(
    cycles(labels.duration), MIN_SIGNAL_DURATION, 50, 0.5, source.signalDuration,
    function (obj, value) { obj.signalDuration = Math.max(value, MIN_SIGNAL_DURATION); },
    '<p>' + labels.durationInfo + '</p>'
  );
  if (source.signalType === 'noise') {
    objBar.createNumber(
      t('noiseSeed'), 0, 99, 1, source.signalSeed,
      function (obj, value) { obj.signalSeed = Math.max(0, Math.round(value)); },
      '<p>' + t('noiseSeedInfo') + '</p>',
      true
    );
  }
}
