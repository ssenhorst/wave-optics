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
 * @file `src/widget/ControlPanel.js` draws the scene's `controls`: the sliders and meters that are
 * always on screen.
 *
 * The rest of the widget assumes a student who will explore — who will click things to find out
 * what they do. That assumption fails for someone looking at their first ray diagram, who does not
 * yet know that the lenses are the parts that matter or that a lens has a strength you can change.
 * This panel removes the guessing: every quantity the exercise is about is on screen, named, with
 * its range shown by where the handle sits.
 *
 * The meters are the other half. The exercise is about a cause and an effect — steep rays at a
 * glass surface make a blurred picture — and the cause is invisible in a ray diagram unless someone
 * puts a number on it. So the panel shows that number next to the sliders that change it.
 */

import { setByKeyPath, getByKeyPath } from '../core/propertyUtils/keyPath.js';
import { readMeter } from '../core/controls.js';
import { totalLensPower } from '../core/imaging/prescription.js';

/**
 * Make an element.
 * @param {string} tag - The tag.
 * @param {string} [className] - Its class.
 * @param {string} [text] - Its text.
 * @returns {HTMLElement} The element.
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The panel of sliders and meters.
 * @class
 */
class ControlPanel {
  /**
   * @param {HTMLElement} root - Where to draw it.
   * @param {Scene} scene - The scene.
   * @param {Object} handlers - What to call when something changes.
   * @param {function(boolean):void} handlers.onChange - Called with whether the change is still in
   * progress, after a slider has been moved.
   */
  constructor(root, scene, handlers) {
    /** @property {HTMLElement} root - The container. */
    this.root = root;
    /** @property {Scene} scene - The scene. */
    this.scene = scene;
    /** @property {Object} handlers - The callbacks. */
    this.handlers = handlers;
    /** @property {Array<Object>} sliders - The built sliders, for refreshing. */
    this.sliders = [];
    /** @property {Array<Object>} meters - The built meters, for refreshing. */
    this.meters = [];
  }

  /** @returns {boolean} Whether the scene asks for a panel at all. */
  get active() {
    const config = this.scene.controls;
    return !!(config && (config.groups?.length || config.meters?.length));
  }

  /** Build the panel for the current scene. */
  build() {
    this.root.innerHTML = '';
    this.sliders = [];
    this.meters = [];

    const config = this.scene.controls;
    if (!this.active) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';

    if (config.title || config.note) {
      const head = el('div', 'ro-sliders-head');
      if (config.title) head.appendChild(el('span', 'ro-sliders-title', config.title));
      if (config.note) head.appendChild(el('span', 'ro-sliders-note', config.note));
      this.root.appendChild(head);
    }

    if (config.groups?.length) {
      const body = el('div', 'ro-sliders-body');
      for (const group of config.groups) {
        body.appendChild(this.buildGroup(group));
      }
      this.root.appendChild(body);
    }

    if (config.meters?.length) {
      const meters = el('div', 'ro-meters');
      for (const meter of config.meters) {
        meters.appendChild(this.buildMeter(meter));
      }
      this.root.appendChild(meters);
    }

    this.refresh();
  }

  /**
   * One object's sliders.
   * @param {Object} group - The group definition.
   * @returns {HTMLElement} The group.
   */
  buildGroup(group) {
    const node = el('div', 'ro-slider-group');
    node.appendChild(el('div', 'ro-slider-group-label', group.label || group.object));

    const obj = (this.scene.objs || []).find(o => o.name === group.object);
    for (const slider of group.sliders) {
      node.appendChild(this.buildSlider(obj, slider));
    }
    return node;
  }

  /**
   * One slider.
   * @param {BaseSceneObj|undefined} obj - The object it edits.
   * @param {Object} definition - The slider definition.
   * @returns {HTMLElement} The row.
   */
  buildSlider(obj, definition) {
    const row = el('label', 'ro-slider-row');
    row.appendChild(el('span', 'ro-slider-label', definition.label || definition.property));

    const input = el('input', 'ro-slider-input');
    input.type = 'range';
    input.min = definition.min;
    input.max = definition.max;
    input.step = definition.step ?? (definition.max - definition.min) / 100;
    if (definition.help) input.title = definition.help;
    if (!obj) input.disabled = true;

    const value = el('span', 'ro-slider-value');

    const apply = (live) => {
      if (!obj) return;
      setByKeyPath(obj, definition.property, parseFloat(input.value));
      this.handlers.onChange(live);
      this.refresh();
    };
    input.addEventListener('input', () => apply(true));
    input.addEventListener('change', () => apply(false));

    row.appendChild(input);
    row.appendChild(value);

    this.sliders.push({ obj, definition, input, value });
    return row;
  }

  /**
   * One read-only meter.
   * @param {Object} definition - The meter definition.
   * @returns {HTMLElement} The meter.
   */
  buildMeter(definition) {
    const node = el('div', 'ro-meter');
    const head = el('div', 'ro-meter-head');
    head.appendChild(el('span', 'ro-meter-label', definition.label || definition.source));
    const value = el('span', 'ro-meter-value', '—');
    head.appendChild(value);
    node.appendChild(head);

    const track = el('div', 'ro-meter-track');
    const fill = el('div', 'ro-meter-fill');
    track.appendChild(fill);
    node.appendChild(track);

    this.meters.push({ definition, value, fill, node });
    return node;
  }

  /** Re-read every slider and meter from the scene. */
  refresh() {
    for (const slider of this.sliders) {
      if (!slider.obj) continue;
      const current = getByKeyPath(slider.obj, slider.definition.property);
      if (typeof current === 'number' && document.activeElement !== slider.input) {
        slider.input.value = current;
      }
      const decimals = (slider.definition.step ?? 0.01) < 0.1 ? 2 : 1;
      // Adding zero turns a negative zero back into a zero, which is what a reader expects to see
      // when a slider is sitting exactly in the middle of its range.
      slider.value.textContent = typeof current === 'number'
        ? (current + 0).toFixed(decimals).replace(/^-0(\.0*)?$/, '0$1') + (slider.definition.suffix ?? '')
        : '—';
    }

    for (const meter of this.meters) {
      const reading = readMeter(meter.definition, this.scene, totalLensPower);
      meter.value.textContent = reading.text;
      meter.fill.style.width = `${Math.round(reading.fraction * 100)}%`;
      meter.node.classList.toggle('is-off-target', !reading.onTarget);
    }
  }
}

export default ControlPanel;
