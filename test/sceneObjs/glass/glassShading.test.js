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

import {
  glassShadeAlpha, SHADE_REFERENCE_INDEX, SHADE_REFERENCE_ALPHA
} from '../../../src/core/sceneObjs/glassShading';
import Scene from '../../../src/core/Scene';

describe('glassShadeAlpha', () => {
  let scene;

  beforeEach(() => {
    scene = new Scene();
  });

  it('defaults to a contrast of 1, and pins ordinary glass to the reference fill', () => {
    expect(scene.theme.glass.contrast).toBe(1);
    expect(glassShadeAlpha(SHADE_REFERENCE_INDEX, scene)).toBeCloseTo(SHADE_REFERENCE_ALPHA, 12);
  });

  it('draws a weakly refracting material faintly at the default contrast', () => {
    expect(glassShadeAlpha(1.2, scene)).toBeCloseTo(0.0899, 4);
  });

  it('scales linearly with the contrast', () => {
    const plain = glassShadeAlpha(1.2, scene);
    scene.theme.glass.contrast = 2.2;
    expect(glassShadeAlpha(1.2, scene)).toBeCloseTo(plain * 2.2, 12);
  });

  it('a contrast of log(1.5)/log(n) gives index n the weight 1.5 has by default', () => {
    for (const n of [1.1, 1.2, 1.33, 2]) {
      scene.theme.glass.contrast = Math.log(SHADE_REFERENCE_INDEX) / Math.log(n);
      expect(glassShadeAlpha(n, scene)).toBeCloseTo(SHADE_REFERENCE_ALPHA, 12);
    }
  });

  it('is negative below an index of 1, so the nonphysical case is still distinguished', () => {
    expect(glassShadeAlpha(1 / 1.5, scene)).toBeCloseTo(-SHADE_REFERENCE_ALPHA, 12);
  });

  it('falls back to a contrast of 1 when the scene or its theme is missing', () => {
    expect(glassShadeAlpha(1.5, undefined)).toBeCloseTo(SHADE_REFERENCE_ALPHA, 12);
    expect(glassShadeAlpha(1.5, {})).toBeCloseTo(SHADE_REFERENCE_ALPHA, 12);
  });
});

describe('theme.glass.contrast in a scene file', () => {
  const load = (json) => new Promise((resolve) => {
    const scene = new Scene();
    scene.loadJSON(JSON.stringify(json), (needFullUpdate, completed) => {
      if (completed) resolve(scene);
    });
  });

  it('is left out of a scene that does not set it', async () => {
    const scene = await load({ version: 5, objs: [] });
    expect(JSON.parse(scene.toJSON()).theme).toBeUndefined();
  });

  it('round-trips on its own, without dragging the glass colour along', async () => {
    const scene = await load({ version: 5, objs: [], theme: { glass: { contrast: 2.2 } } });
    expect(scene.error).toBeNull();
    expect(scene.theme.glass.contrast).toBe(2.2);
    expect(scene.theme.glass.color).toEqual({ r: 1, g: 1, b: 1 });
    expect(JSON.parse(scene.toJSON()).theme).toEqual({ glass: { contrast: 2.2 } });
  });
});
