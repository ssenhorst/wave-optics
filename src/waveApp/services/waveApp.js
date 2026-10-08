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
 * @file The application service for the wave-optics app: the glue between the
 * core library ({@link Scene}, {@link Editor}, {@link WaveSimulator}) and the
 * Vue UI.
 *
 * This is a deliberately lean counterpart to `src/app/services/app.js` rather
 * than a refactor of it. The wave app was split off to stay clear of the ray
 * simulator's engine selection, colour modes and export paths, none of which
 * apply here; reusing that service would drag all of it back in. What *is*
 * reused is everything genuinely shared: the scene model, the editor, the
 * geometry helpers and the object bar.
 */

import 'bootstrap/scss/bootstrap.scss';
import { Scene, Editor, sceneObjs } from '../../core/index.js';
import WaveSimulator from '../../core/waveOptics/WaveSimulator.js';
import { createWaveRenderingContext } from '../../core/waveOptics/WaveFieldEngineWebGL2.js';
import { objBar } from '../../app/services/objBar.js';
import { saveAs } from 'file-saver';
import { buildExampleScene, EXAMPLE_SCENES } from '../exampleScenes.js';
import { resolveUiOptions } from '../../core/uiOptions.js';

/** Scene object types the wave app offers as tools. */
export const WAVE_TOOL_TYPES = ['WavePointSource', 'WaveRuler'];

let scene = null;
let simulator = null;
let editor = null;
let canvasWave = null;
let canvasBelowLight = null;
let canvasAboveLight = null;
let canvasGrid = null;
let canvasInteraction = null;

const listeners = {};

/**
 * Subscribe to an app-level event ('statusChange', 'selectionChange',
 * 'sceneChange').
 * @param {string} name
 * @param {function} callback
 */
function on(name, callback) {
  (listeners[name] ??= []).push(callback);
}

/**
 * @param {string} name
 * @param {*} detail
 */
function emit(name, detail) {
  for (const callback of listeners[name] ?? []) callback(detail);
}

/**
 * Whether the app was opened as a task designer, asked for with `?design=1` in the URL. The scene's
 * interaction permissions and interface options are then read, written and saved as usual but not
 * enforced, so whoever is authoring the task can reach everything.
 * @returns {boolean} Whether the task designer is on.
 */
function isDesignMode() {
  if (typeof window === 'undefined') return false;
  const design = new URLSearchParams(window.location.search).get('design');
  return design !== null && design !== '0' && design !== 'false';
}

/** Create the scene. Must run before the Vue app mounts, since controls bind to it. */
function initScene() {
  scene = new Scene();
  scene.backgroundImage = null;
  scene.designMode = isDesignMode();
  app.scene = scene;
  app.designMode = scene.designMode;
}

/**
 * Show or hide the parts of the interface the scene asks to hide. They are hidden with a class on
 * `body` rather than by unmounting, since the app reaches into these elements directly by id.
 */
function applyUiOptions() {
  const ui = resolveUiOptions(scene);
  const hidden = {
    'ro-hide-toolbar': !ui.toolbar,
    'ro-hide-objbar': !ui.objectBar,
    'ro-hide-statusbar': !ui.statusBar,
  };
  for (const [className, on] of Object.entries(hidden)) {
    document.body.classList.toggle(className, on);
  }
}

/**
 * Keep the goal targets of a task in step with draggable handles on the canvas, so a designer can
 * place them by dragging rather than by typing coordinates.
 */
function refreshGoalHandles() {
  if (!scene.designMode || !editor) return;
  const goals = (scene.task && scene.task.goals) || [];
    const handles = [];
    goals.forEach((goal, index) => {
      if (!goal) return;
      const label = goal.targetLabel || goal.id || `goal ${index + 1}`;

      if (goal.point && typeof goal.point.x === 'number') {
        handles.push({
          point: goal.point,
          radius: goal.radius,
          label,
          onDrag: (pos) => {
            goal.point.x = Math.round(pos.x * 100) / 100;
            goal.point.y = Math.round(pos.y * 100) / 100;
          },
        });
      }

      // A goal that measures along a line is placed by its two ends.
      if (goal.line && goal.line.p1 && goal.line.p2) {
        for (const [end, other] of [['p1', 'p2'], ['p2', 'p1']]) {
          handles.push({
            point: goal.line[end],
            label: end === 'p1' ? `${label} probe` : '',
            lineTo: goal.line[other],
            onDrag: (pos) => {
              goal.line[end].x = Math.round(pos.x * 100) / 100;
              goal.line[end].y = Math.round(pos.y * 100) / 100;
            },
          });
        }
      }
    });
  editor.externalHandles = handles;
}

/**
 * Load a scene from a URL relative to the app, which is how the task designer opens a task file.
 * @param {string} url - The URL of the scene JSON.
 */
function openSceneFromUrl(url) {
  const client = new XMLHttpRequest();
  client.open('GET', url);
  client.onload = () => {
    if (client.status >= 300) {
      emit('statusChange', { error: `Could not load ${url} (${client.status})` });
      return;
    }
    scene.backgroundImage = null;
    editor.loadJSON(client.responseText);
    applyUiOptions();
    refreshGoalHandles();
    // The handles are known only after the scene is in place, so the layer they live on is redrawn.
    simulator.updateSimulation(true, true);
    emit('sceneChange', null);
  };
  client.onerror = () => emit('statusChange', { error: `Could not load ${url}` });
  client.send();
}

/** The canvas size last applied, so no-op resize events can be ignored. */
let lastCanvasWidth = -1;
let lastCanvasHeight = -1;

/** Wire up the canvases, simulator, editor and object bar. */
function initAppService() {
  canvasGrid = document.getElementById('waveCanvasGrid');
  canvasBelowLight = document.getElementById('waveCanvasBelow');
  canvasWave = document.getElementById('waveCanvasField');
  canvasAboveLight = document.getElementById('waveCanvasAbove');
  canvasInteraction = canvasAboveLight;

  app.canvasWave = canvasWave;

  let gl = null;
  try {
    gl = createWaveRenderingContext(canvasWave);
  } catch (e) {
    app.fatalError = e.message;
    emit('statusChange', { error: e.message });
    return;
  }

  simulator = new WaveSimulator({
    scene,
    gl,
    ctxBelowLight: canvasBelowLight.getContext('2d'),
    ctxAboveLight: canvasAboveLight.getContext('2d'),
    ctxGrid: canvasGrid.getContext('2d'),
  });
  simulator.dpr = window.devicePixelRatio || 1;
  app.simulator = simulator;

  editor = new Editor(scene, canvasInteraction, simulator);
  app.editor = editor;

  objBar.initialize(
    document.getElementById('wave_obj_bar_main'),
    document.getElementById('wave_obj_name')
  );
  app.objBar = objBar;

  bindEditorEvents();
  bindSimulatorEvents();
  bindObjBarEvents();

  window.addEventListener('resize', onResize);
  onResize();

  window.addEventListener('keydown', onKeyDown);

  // A link to a scene is the whole scene, so the address bar is checked before
  // anything else has a chance to overwrite it. The back button goes through
  // the same path, which is what makes an undo of a shared link work.
  window.addEventListener('popstate', loadFromUrl);
  loadFromUrl();
}

/**
 * The handful of keyboard shortcuts worth having: undo, redo, delete, and
 * escaping out of placing an object. Skipped entirely while an editable
 * element has focus, so typing "z" into an equation field does not undo the
 * scene out from under it.
 *
 * @param {KeyboardEvent} e
 */
function onKeyDown(e) {
  if (!editor || !scene) return;

  const target = e.target;
  const isEditable = target?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);
  if (isEditable) return;

  const ctrlOrCmd = e.ctrlKey || e.metaKey;

  if (ctrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'z') {
    editor.undo();
    e.preventDefault();
    return;
  }
  if ((ctrlOrCmd && e.shiftKey && e.key.toLowerCase() === 'z') ||
    (ctrlOrCmd && e.key.toLowerCase() === 'y')) {
    editor.redo();
    e.preventDefault();
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (editor.selectedObjIndex !== -1 && scene.objs[editor.selectedObjIndex]) {
      const type = scene.objs[editor.selectedObjIndex].constructor.type;
      editor.removeObj(editor.selectedObjIndex);
      editor.hoveredObjIndex = -1;
      simulator.updateSimulation(!sceneObjs[type]?.isOptical, true);
      editor.onActionComplete();
    }
    e.preventDefault();
    return;
  }

  // Escape backs out of placing an object rather than completing it, the same
  // as the ray simulator: onConstructUndo lets the object itself decide
  // whether that means stepping back one vertex or cancelling outright.
  if (e.key === 'Escape' && editor.isConstructing) {
    editor.undo();
    e.preventDefault();
  }
}

/**
 * Resize every canvas layer and tell the scene about the new viewport.
 *
 * Resize events fire for reasons that leave the size unchanged (a device pixel
 * ratio change that rounds to the same pixels, mobile browser chrome sliding in
 * and out, devtools docking). Assigning to `canvas.width` clears the canvas
 * even when the value is identical, and recomputing the field is expensive, so
 * a resize that changes nothing is ignored.
 */
function onResize() {
  if (!scene) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(window.innerWidth * dpr);
  const height = Math.round(window.innerHeight * dpr);
  if (width === lastCanvasWidth && height === lastCanvasHeight) return;
  lastCanvasWidth = width;
  lastCanvasHeight = height;

  for (const canvas of [canvasGrid, canvasBelowLight, canvasWave, canvasAboveLight]) {
    if (!canvas) continue;
    canvas.width = width;
    canvas.height = height;
  }
  if (simulator) simulator.dpr = dpr;
  scene.setViewportSize(window.innerWidth, window.innerHeight);
  simulator?.updateSimulation(false, false);
}

function bindEditorEvents() {
  editor.on('selectionChange', (e) => {
    if (objBar.pendingEvent) {
      // Clearing the object bar would otherwise swallow an in-progress edit.
      objBar.pendingEvent();
      objBar.pendingEvent = null;
    }

    const bar = document.getElementById('wave_obj_bar');
    const main = document.getElementById('wave_obj_bar_main');
    if (e.newIndex >= 0 && scene.objs[e.newIndex]) {
      objBar.targetObj = scene.objs[e.newIndex];
      main.innerHTML = '';
      scene.objs[e.newIndex].populateObjBar(objBar);
      bar.style.display = '';
    } else {
      bar.style.display = 'none';
      objBar.shouldShowAdvanced = false;
    }

    // Wave objects show their drag handles only while selected, so a selection
    // change has to redraw them. The field itself is unaffected, so only the
    // object layer is redrawn, which is free next to recomputing it.
    //
    // Deferred by a microtask because the editor emits this event before it
    // stores the new index: drawing now would ask every object whether it is
    // selected and get the previous answer.
    queueMicrotask(() => simulator.updateSimulation(true, true));
    emit('selectionChange', { index: e.newIndex });
  });

  editor.on('newAction', () => {
    refreshGoalHandles();
    syncUrl();
    emit('sceneChange', null);
  });

  // Every path that replaces the scene ends here, so the interface options and the designer's
  // handles are re-read wherever the scene came from: a file, the URL hash or an example.
  editor.on('sceneLoaded', () => {
    applyUiOptions();
    refreshGoalHandles();
  });
  applyUiOptions();

  if (scene.designMode) {
    // The designer is a tool for whoever is authoring the task, so its internals are reachable from
    // the console. The app students get does not expose this.
    window.waveOpticsApp = app;
  }

  // Switch back to the move-view tool the instant an object is placed, so a
  // second, unintended click on the canvas cannot start placing a duplicate.
  // Continuous same-type placement (the ray simulator's convention) is a
  // different default that would fight this, so it is not reused here.
  editor.on('objectConstructed', () => setTool(''));

  editor.on('mouseCoordinateChange', (e) => {
    emit('statusChange', { mousePos: e.mousePos });
  });

  editor.on('positioningStart', (e) => {
    const box = document.getElementById('wave-xybox-container');
    const input = document.getElementById('wave-xybox');
    if (!box || !input) return;
    box.style.left = (e.dragContext.targetPoint.x * scene.scale + scene.origin.x) + 'px';
    box.style.top = (e.dragContext.targetPoint.y * scene.scale + scene.origin.y) + 'px';
    input.value = `(${e.dragContext.targetPoint.x},${e.dragContext.targetPoint.y})`;
    input.size = input.value.length;
    box.style.display = '';
    input.select();
  });

  editor.on('positioningEnd', () => {
    const box = document.getElementById('wave-xybox-container');
    if (box) box.style.display = 'none';
  });

  editor.on('requestPositioningComfirm', (e) => {
    const input = document.getElementById('wave-xybox');
    if (!input) return;
    const parsed = input.value.match(/^\(?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)?$/);
    if (!parsed) return;
    editor.confirmPositioning(
      parseFloat(parsed[1]), parseFloat(parsed[2]), e.ctrl, e.shift
    );
  });
}

function bindSimulatorEvents() {
  simulator.on('fieldComputed', (e) => {
    emit('statusChange', {
      diagnostics: e.diagnostics,
      warnings: e.warnings,
      gridWidth: e.gridWidth,
      gridHeight: e.gridHeight,
      computeMs: e.computeMs,
      error: simulator.getError(),
    });
  });

  simulator.on('timeChange', (e) => emit('timeChange', e));
  simulator.on('animationChange', (e) => emit('animationChange', e));
  simulator.on('requestUpdateErrorAndWarning', () => {
    emit('statusChange', { error: simulator.getError() });
  });
}

function bindObjBarEvents() {
  objBar.on('edit', () => {
    simulator.updateSimulation(false, true);
  });
  objBar.on('editEnd', () => {
    editor.onActionComplete();
  });
  objBar.on('requestUpdate', () => {
    editor.selectObj(editor.selectedObjIndex);
  });
}

/**
 * Select the active tool.
 * @param {string} type - A scene object type, or '' for the move-view tool.
 */
function setTool(type) {
  if (!editor) return;
  editor.addingObjType = type;
  app.tool = type;
  emit('toolChange', { tool: type });
}

/** Re-run the simulation after a settings change. */
function refresh({ recomputeField = true } = {}) {
  if (!simulator) return;
  if (recomputeField) {
    simulator.updateSimulation(false, true);
  } else {
    simulator.render();
  }
}

/** Remove every object from the scene. */
function clearScene() {
  if (!scene || !editor) return;
  scene.objs = [];
  editor.selectObj(-1);
  simulator.updateSimulation(false, true);
  editor.onActionComplete();
  emit('sceneChange', null);
}

/**
 * Replace the scene with one of the built-in examples.
 *
 * The example is built against the current viewport, so it fills whatever
 * window it is loaded into. With the scene at unit scale and the origin at the
 * corner, scene length units and CSS pixels coincide.
 *
 * @param {string} id
 */
function loadExample(id) {
  if (!scene || !editor) return;
  const json = buildExampleScene(id, scene.width, scene.height);
  if (!json) return;
  editor.loadJSON(json);
  editor.onActionComplete();
  emit('sceneChange', null);
}

/** Download the scene as JSON. */
function saveScene() {
  const blob = new Blob([scene.toJSON()], { type: 'application/json;charset=utf-8' });
  saveAs(blob, (scene.name || 'wave-scene') + '.json');
}

/**
 * How long after the last edit the URL is rewritten. Long enough that typing in
 * a number field does not compress the scene on every keystroke.
 */
const URL_SYNC_DELAY_MS = 800;

/**
 * The longest URL worth producing. Past roughly two kilobytes a link stops
 * surviving being pasted into things, so a scene that will not fit is reported
 * rather than silently truncated to something that will not load.
 */
const MAX_URL_LENGTH = 2041;

let syncUrlTimerId = -1;
let lastSyncedHash = '';

/** Compress the current scene into the address bar. */
function syncUrl() {
  if (!app.autoSyncUrl || !scene) return;
  if (syncUrlTimerId !== -1) clearTimeout(syncUrlTimerId);

  syncUrlTimerId = setTimeout(() => {
    syncUrlTimerId = -1;
    encodeScene().then((encoded) => {
      if (!encoded) return;
      const full = window.location.href.split('#')[0] + '#' + encoded;
      if (full.length > MAX_URL_LENGTH) {
        emit('statusChange', { urlWarning: 'tooLarge' });
        return;
      }
      emit('statusChange', { urlWarning: null });
      // A large change gets its own history entry, so the back button can
      // recover a scene that was replaced by accident; small ones do not, or
      // every slider drag would fill the history.
      const method = Math.abs(full.length - lastSyncedHash.length) > 200
        ? 'pushState' : 'replaceState';
      lastSyncedHash = full;
      window.history[method](undefined, undefined, '#' + encoded);
    }).catch(() => {
      emit('statusChange', { urlWarning: 'failed' });
    });
  }, URL_SYNC_DELAY_MS);
}

/** @returns {Promise<string>} The current scene, compressed for a URL hash. */
function encodeScene() {
  return require('json-url')('lzma').compress(JSON.parse(scene.toJSON()));
}

/** Put a shareable link to the current scene on the clipboard. */
function copyLink() {
  return encodeScene().then((encoded) => {
    const url = window.location.href.split('#')[0] + '#' + encoded;
    if (url.length > MAX_URL_LENGTH) {
      emit('statusChange', { urlWarning: 'tooLarge' });
    }
    // Written to the address bar as well as the clipboard, so the link is
    // recoverable even where the clipboard API is refused.
    window.history.replaceState(undefined, undefined, '#' + encoded);
    return navigator.clipboard?.writeText(url).then(() => url).catch(() => url) ?? url;
  });
}

/**
 * Load the scene the address bar names, if it names one.
 *
 * @returns {boolean} Whether a scene was found and loading was started.
 */
function loadFromUrl() {
  // A scene named in the query string, which is how the task designer opens a task file. A path
  // relative to the app only: no scheme and no protocol-relative URL. It takes precedence over the
  // hash, since it names a file the author is editing rather than a scene someone shared.
  const requestedScene = new URLSearchParams(window.location.search).get('scene');
  if (requestedScene && /^[\w./-]+$/.test(requestedScene)
    && !requestedScene.includes(':') && !requestedScene.startsWith('//')) {
    openSceneFromUrl(requestedScene);
    return true;
  }

  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (!hash) return false;

  // A bare example name rather than a compressed scene: this is what the
  // gallery links to, since an example is built from the window it is loaded
  // into and so has no fixed scene to encode.
  if (EXAMPLE_SCENES.some((example) => example.id === hash)) {
    loadExample(hash);
    return true;
  }
  if (hash.length < 8) return false;

  require('json-url')('lzma').decompress(hash).then((json) => {
    scene.backgroundImage = null;
    editor.loadJSON(JSON.stringify(json));
    editor.onActionComplete();
    emit('sceneChange', null);
  }).catch((e) => {
    emit('statusChange', { error: 'Could not read the scene from the URL: ' + e });
  });
  return true;
}

/**
 * Load a scene from a JSON file.
 * @param {File} file
 */
function openScene(file) {
  const reader = new FileReader();
  reader.onload = () => {
    // Editor.loadJSON also resets the selection and drives the redraw.
    editor.loadJSON(String(reader.result));
    editor.onActionComplete();
    emit('sceneChange', null);
  };
  reader.readAsText(file);
}

/**
 * The wave-optics application service.
 * @namespace waveApp
 */
export const app = {
  scene: null,
  simulator: null,
  editor: null,
  objBar: null,
  tool: '',
  fatalError: null,
  /**
   * Whether every edit is written back into the address bar, so the URL is
   * always a link to what is on screen.
   */
  autoSyncUrl: false,
  initScene,
  initAppService,
  isDesignMode,
  openSceneFromUrl,
  setTool,
  refresh,
  clearScene,
  loadExample,
  saveScene,
  openScene,
  syncUrl,
  copyLink,
  sceneObjs,
  on,
};

export default app;
