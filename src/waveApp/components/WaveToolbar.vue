<!--
  Copyright 2026 The Wave Optics Simulation authors and contributors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

<template>
  <div class="wave-toolbar">
    <div class="wave-toolbar-row">
      <!-- File -->
      <div class="btn-group">
        <button class="btn btn-sm btn-outline-light" @click="onNew">New</button>
        <button class="btn btn-sm btn-outline-light" @click="onOpen">Open</button>
        <button class="btn btn-sm btn-outline-light" @click="onSave">Save</button>
        <button class="btn btn-sm btn-outline-light" :title="linkTitle" @click="onCopyLink">
          {{ linkLabel }}
        </button>
      </div>

      <span class="wave-divider"></span>

      <!-- Examples -->
      <select class="form-select form-select-sm wave-select" v-model="example"
        @change="onExampleChosen" title="Load a worked example">
        <option value="">Examples&hellip;</option>
        <option v-for="entry in examples" :key="entry.id" :value="entry.id"
          :title="entry.description">
          {{ entry.name }}
        </option>
      </select>

      <span class="wave-divider"></span>

      <!-- Tools -->
      <button
        class="btn btn-sm"
        :class="tool === '' ? 'btn-primary' : 'btn-outline-light'"
        title="Drag to pan, scroll to zoom"
        @click="chooseTool('')"
      >Move view</button>

      <div class="wave-menu" v-for="group in toolGroups" :key="group.id">
        <button
          class="btn btn-sm"
          :class="activeItem(group) ? 'btn-primary' : 'btn-outline-light'"
          @click="toggleMenu(group.id)"
        >{{ activeItem(group)?.label ?? group.label }} &#9662;</button>
        <ul class="wave-menu-list" v-show="openMenu === group.id">
          <li v-for="item in group.items" :key="item.type">
            <button
              type="button"
              :class="{ 'wave-menu-active': tool === item.type }"
              :title="item.hint"
              @click="chooseTool(item.type)"
            >
              <img class="wave-menu-icon" :src="toolIcon(item.type)" alt="" loading="lazy">
              <span class="wave-menu-text">
                <span class="wave-menu-label">{{ item.label }}</span>
                <span class="wave-menu-hint">{{ item.hint }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>

      <span class="wave-divider"></span>

      <!-- View -->
      <div class="btn-group">
        <button
          v-for="item in views"
          :key="item.value"
          class="btn btn-sm"
          :class="view === item.value ? 'btn-primary' : 'btn-outline-light'"
          :title="item.hint"
          @click="view = item.value"
        >{{ item.label }}</button>
      </div>

      <!-- Animation -->
      <button class="btn btn-sm" :class="isAnimating ? 'btn-primary' : 'btn-outline-light'"
        @click="toggleAnimation" :disabled="!isTimeResolved"
        :title="isTimeResolved ? 'Animate the instantaneous field' : 'The intensity view is time-averaged, so there is nothing to animate'">
        {{ isAnimating ? 'Pause' : 'Play' }}
      </button>
      <input type="range" class="form-range wave-range" min="0" max="1" step="0.002"
        :value="timeFraction" @input="onScrubTime" :disabled="!isTimeResolved"
        :title="`Time: ${timeLabel}`">
    </div>

    <input type="file" ref="fileInput" accept=".json" style="display:none" @change="onFileChosen">
  </div>
</template>

<script>
/**
 * @module WaveToolbar
 * @description The controls reached for while working: the file commands, the
 * tools, the field view and the animation transport.
 *
 * Everything that is set once and then left — the wavelength, the sampling, the
 * colour scale — lives in {@link module:WaveSidebar} instead. It was all here
 * once, and the row that mattered every minute was the one being crowded out.
 */
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { app } from '../services/waveApp.js';
import { useWaveStore } from '../store/wave.js';
import { EXAMPLE_SCENES } from '../exampleScenes.js';

/**
 * The tools, grouped the way the scene objects divide: things that radiate,
 * things that divide space, and things that only look.
 */
const TOOL_GROUPS = [
  {
    id: 'sources',
    label: 'Sources',
    items: [
      { type: 'WavePointSource', label: 'Point source', hint: 'Click to place a time-harmonic point source' },
      { type: 'WaveLineSource', label: 'Line source', hint: 'Drag to draw a line of point sources with A(u) and phase(u)' },
      { type: 'WavePlaneWave', label: 'Plane wave', hint: 'Drag to place an ideal plane wave and aim it' },
    ],
  },
  {
    id: 'interfaces',
    label: 'Interfaces',
    items: [
      { type: 'WaveInterface', label: 'Interface', hint: 'A surface with transmission given by equations' },
      { type: 'WaveLens', label: 'Lens', hint: 'Two spherical surfaces with glass between, shaped from a focal length' },
      { type: 'WaveMultiSlit', label: 'N slits', hint: 'An opaque screen with a row of identical slits' },
      { type: 'WaveSquareGrating', label: 'Square grating', hint: 'Square-wave transmission, by pitch and duty cycle' },
      { type: 'WaveSinusoidalGrating', label: 'Sinusoidal phase grating', hint: 'A single-frequency phase grating' },
      { type: 'WaveZonePlate', label: 'Fresnel zone plate', hint: 'Zones alternating every half wave of path to the focus' },
      { type: 'WaveBinaryMask', label: 'Binary mask', hint: 'Open wherever a function of y is non-negative' },
    ],
  },
  {
    id: 'measure',
    label: 'Measure',
    items: [
      { type: 'WaveRuler', label: 'Ruler', hint: 'Drag to measure distance along a marked scale' },
      { type: 'WaveScreen', label: 'Screen', hint: 'Drag to set the screen endpoints, then place the far-field vertex' },
      { type: 'WaveFocusProbe', label: 'Focus probe', hint: 'Click to find the brightest point of that subspace' },
    ],
  },
];

export default {
  name: 'WaveToolbar',
  setup() {
    const store = useWaveStore();
    const fileInput = ref(null);
    const example = ref('');
    const openMenu = ref(null);
    const linkLabel = ref('Link');

    // Close an open tool menu when the click lands anywhere else.
    const closeOnOutsideClick = (event) => {
      if (!event.target.closest?.('.wave-menu')) openMenu.value = null;
    };
    onMounted(() => document.addEventListener('click', closeOnOutsideClick));
    onUnmounted(() => document.removeEventListener('click', closeOnOutsideClick));

    const view = store.view;
    // The intensity view is time-averaged; the other two show an instant.
    const isTimeResolved = computed(() => view.value !== 'intensity');

    // The field view shows one optical cycle; the scrubber spans exactly that.
    const timeFraction = computed(() => store.state.time - Math.floor(store.state.time));

    return {
      store,
      fileInput,
      example,
      openMenu,
      linkLabel,
      examples: EXAMPLE_SCENES,
      tool: store.tool,
      view,
      isTimeResolved,
      isAnimating: computed(() => store.state.isAnimating),
      toggleAnimation: store.toggleAnimation,
      timeFraction,
      timeLabel: computed(() => `${timeFraction.value.toFixed(2)} cycle`),
      onScrubTime: (event) => store.setTime(parseFloat(event.target.value)),
      linkTitle: 'Copy a link to this scene. Settings -> Auto sync URL keeps it up to date as you edit',
      toolGroups: TOOL_GROUPS,
      views: [
        { value: 'intensity', label: 'Intensity', hint: 'The time-averaged intensity |U|²' },
        { value: 'field', label: 'Field', hint: 'The instantaneous field Re{U e^{-iωt}}' },
        { value: 'amplitudePhase', label: 'Amp+phase', hint: 'Amplitude and phase together, in Oklch' },
      ],
    };
  },
  methods: {
    /** The item of a group that is the active tool, if any. */
    activeItem(group) {
      return group.items.find((item) => item.type === this.tool) ?? null;
    },
    /**
     * The picture of what a tool does, shown beside its name in the menu.
     *
     * These are renders of the tool itself, made by `scripts/buildWaveImages.mjs`
     * and served from the shared image directory a level up from this app.
     */
    toolIcon(type) {
      if (type === 'WaveRuler') return '../img/Ruler.svg';
      return `../img/wave/tool-${type}.jpg`;
    },
    toggleMenu(id) {
      this.openMenu = this.openMenu === id ? null : id;
    },
    chooseTool(type) {
      this.tool = type;
      this.openMenu = null;
    },
    onNew() {
      this.example = '';
      app.clearScene();
    },
    onExampleChosen(event) {
      const id = event.target.value;
      if (id) app.loadExample(id);
    },
    onOpen() {
      this.fileInput.click();
    },
    onSave() {
      app.saveScene();
    },
    onCopyLink() {
      // Copying a link says the scene is meant to be shared, so the address bar starts tracking it
      // from here on and the link keeps pointing at what is on screen.
      this.store.state.autoSyncUrl = true;
      app.autoSyncUrl = true;
      this.linkLabel = 'Copying…';
      app.copyLink()
        .then(() => { this.linkLabel = 'Copied'; })
        .catch(() => { this.linkLabel = 'Failed'; })
        .finally(() => setTimeout(() => { this.linkLabel = 'Link'; }, 1800));
    },
    onFileChosen(event) {
      const file = event.target.files?.[0];
      if (file) app.openScene(file);
      event.target.value = '';
    },
  },
};
</script>

<style scoped>
.wave-toolbar {
  /* `backdrop-filter` creates its own stacking context, which traps the tool
     menu's z-index inside this element — without a z-index here the menu could
     never rise above the object bar, a later flex sibling in `.wave-chrome`
     that otherwise wins painting order by DOM position alone. Flex items take
     z-index without needing `position` set. */
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  width: 100%;
  background-color: rgba(20, 22, 26, 0.88);
  backdrop-filter: blur(4px);
  color: rgba(255, 255, 255, 0.85);
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 12px;
}

.wave-toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  /* Room on the right for the sidebar tab, which floats over this row. */
  padding: 8px 46px 8px 12px;
}

.wave-divider {
  width: 1px;
  align-self: stretch;
  margin: 0 3px;
  background-color: rgba(255, 255, 255, 0.14);
}

.wave-select {
  width: auto;
  min-width: 130px;
}

.wave-range {
  width: 110px;
  padding-top: 3px;
}

.wave-menu {
  position: relative;
  display: inline-block;
}

.wave-menu-list {
  position: absolute;
  top: calc(100% + 3px);
  left: 0;
  z-index: 30;
  margin: 0;
  padding: 3px 0;
  list-style: none;
  min-width: 200px;
  background-color: rgba(26, 29, 34, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}

.wave-menu-list {
  min-width: 320px;
}

.wave-menu-list button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 5px 12px;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
}

/* A render of the tool doing its one job, which says what it is faster than
   its name does — the same pictures the home page lists it with. */
.wave-menu-icon {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.wave-menu-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.wave-menu-label {
  white-space: nowrap;
}

.wave-menu-hint {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.45);
  white-space: normal;
  line-height: 1.25;
}

.wave-menu-list button:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.wave-menu-list button.wave-menu-active {
  color: #7db3ff;
}

.btn-sm {
  --bs-btn-padding-y: 0.15rem;
  --bs-btn-padding-x: 0.45rem;
  --bs-btn-font-size: 0.75rem;
}

.form-control-sm,
.form-select-sm {
  font-size: 0.75rem;
  padding: 0.15rem 0.4rem;
}
</style>
