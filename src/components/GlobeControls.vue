<script setup>
import ColorBar from "@/components/ColorBar.vue";
</script>

<script>
import { defineComponent } from "vue";
export default defineComponent({
  props: ["modelInfo", "varinfo"],
  emits: ["selection", "onSnapshot", "onExample", "onRotate"],
  data() {
    console.log(this.modelInfo);
    return {
      menu_collapsed: false,
      time_index: 1,
      current_var_attrs: {},
      enable_coastlines: true,
      varname: "-",
      colormap: "turbo",
      invert_colormap: true,
      auto_colormap: true,
      default_bounds: { low: undefined, high: undefined },
      user_bounds_low: undefined,
      user_bounds_high: undefined,
      picked_bounds: "auto",
      view: {},
    };
  },
  watch: {
    time_index() {
      this.publish();
    },
    varname() {
      const varinfo = this.modelInfo.vars[this.varname];
      this.default_bounds = varinfo.default_range || {
        low: undefined,
        high: undefined,
      };
      this.setDefaultColormap();
      this.publish();
    },
    colormap() {
      this.publish();
    },
    invert_colormap() {
      this.publish();
    },
    bounds() {
      this.publish();
    },
    enable_coastlines() {
      this.publish();
    },
    modelInfo() {
      if (this.modelInfo.vars[this.varname] === undefined) {
        this.varname =
          this.modelInfo.default_var || Object.keys(this.modelInfo.vars)[0];
      }
      this.setDefaultColormap();
    },
    auto_colormap() {
      this.setDefaultColormap();
    },
  },
  methods: {
    toggle_collapsed() {
      this.menu_collapsed = !this.menu_collapsed;
    },
    publish() {
      this.$emit("selection", {
        bounds: this.bounds,
        varname: this.varname,
        timeIndex: this.time_index,
        colormap: this.colormap,
        invertColormap: this.invert_colormap,
        enableCoastlines: this.enable_coastlines,
      });
    },
    setDefaultColormap() {
      const defaultColormap =
        this.modelInfo.vars[this.varname].default_colormap;
      if (this.auto_colormap && defaultColormap !== undefined) {
        this.invert_colormap = defaultColormap.inverted || false;
        this.colormap = defaultColormap.name;
      }
    },
  },
  computed: {
    active_bounds() {
      if (this.picked_bounds == "auto") {
        if (
          this.default_bounds.low !== undefined &&
          this.default_bounds.high !== undefined
        ) {
          return "default";
        } else {
          return "data";
        }
      } else {
        return this.picked_bounds;
      }
    },
    bounds() {
      if (this.active_bounds == "data") {
        return this.data_bounds;
      } else if (this.active_bounds == "default") {
        return this.default_bounds;
      } else if (this.active_bounds == "user") {
        return { low: this.user_bounds_low, high: this.user_bounds_high };
      }
      return undefined;
    },
    data_bounds() {
      if (this.varinfo && this.varinfo.bounds) {
        return this.varinfo.bounds;
      } else {
        return { low: undefined, high: undefined };
      }
    },
    time_range() {
      if (this.varinfo && this.varinfo.time_range) {
        return this.varinfo.time_range;
      } else {
        return { start: 0, end: 1 };
      }
    },
    current_time_index() {
      if (this.varinfo && this.varinfo.time_index) {
        return this.varinfo.time_index;
      } else {
        return undefined;
      }
    },
    current_time_value() {
      if (this.varinfo && this.varinfo.timeinfo) {
        return this.varinfo.timeinfo.current;
      } else {
        return undefined;
      }
    },
    current_var_name() {
      if (this.varinfo && this.varinfo.varname) {
        return this.varinfo.varname;
      } else {
        return "-";
      }
    },
    current_var_longname() {
      if (this.varinfo && this.varinfo.attrs && this.varinfo.attrs.long_name) {
        return this.varinfo.attrs.long_name;
      } else {
        return "-";
      }
    },
    current_var_units() {
      if (this.varinfo && this.varinfo.attrs && this.varinfo.attrs.units) {
        return this.varinfo.attrs.units;
      } else {
        return "-";
      }
    },
  },
});
</script>

<template>
  <nav class="panel gl_controls" id="main_controls">
    <div
      class="panel-heading"
      style="display: flex; justify-content: space-between"
    >
      <div class="text-wrap" v-if="modelInfo">
        {{ modelInfo.title }}
      </div>
      <div v-else>no data available</div>
      <div>
        <i
          class="fa-solid"
          :class="{
            'fa-angle-down': menu_collapsed,
            'fa-angle-up': !menu_collapsed,
          }"
          @click="toggle_collapsed"
        ></i>
      </div>
    </div>

    <div
      class="panel-block"
      :class="{ 'is-hidden': menu_collapsed }"
      v-if="modelInfo"
    >
      <div class="select is-fullwidth">
        <select class="form-control" v-model="varname">
          <option
            v-for="varname in Object.keys(modelInfo.vars)"
            :value="varname"
            :key="varname"
          >
            {{ varname }}
          </option>
        </select>
      </div>
    </div>
    <div
      class="panel-block"
      :class="{ 'is-hidden': menu_collapsed }"
      v-if="modelInfo"
    >
      <div class="control">
        <div class="mb-2 w-100 is-flex is-justify-content-space-between">
          <div class="my-2">Time:</div>
          <div class="is-flex">
            <input
              class="input"
              type="number"
              v-model.number="time_index"
              style="width: 8em"
            />
            <div class="my-2">/ {{ time_range.end }}</div>
          </div>
        </div>
        <input
          class="w-100"
          type="range"
          v-bind:min="time_range.start"
          v-bind:max="time_range.end"
          v-model.number="time_index"
        />
        <div class="w-100 is-flex is-justify-content-space-between">
          <div>Currently shown:</div>
          <div class="has-text-right">
            {{ current_var_name }} @ {{ current_time_index }}
            <br />
            <span v-if="current_time_value">
              {{ current_time_value.format() }}
            </span>
            <br />
          </div>
        </div>
        <div class="has-text-right">
          {{ current_var_longname }} / {{ current_var_units }}
        </div>
      </div>
    </div>
    <div
      class="panel-block"
      :class="{ 'is-hidden': menu_collapsed }"
      v-if="modelInfo"
    >
      <table>
        <tr>
          <th>range</th>
          <th>low</th>
          <th class="right">high</th>
        </tr>
        <tr :class="{ active: active_bounds === 'data' }">
          <td>
            <input
              type="radio"
              id="data_bounds"
              value="data"
              v-model="picked_bounds"
            /><label for="data_bounds">data</label>
          </td>
          <td>{{ Number(data_bounds.low).toPrecision(4) }}</td>
          <td class="right">{{ Number(data_bounds.high).toPrecision(4) }}</td>
        </tr>
        <tr :class="{ active: active_bounds === 'default' }">
          <td>
            <input
              type="radio"
              id="default_bounds"
              value="default"
              v-model="picked_bounds"
            /><label for="default_bounds">default</label>
          </td>
          <td>{{ Number(default_bounds.low).toPrecision(2) }}</td>
          <td class="right">
            {{ Number(default_bounds.high).toPrecision(2) }}
          </td>
        </tr>
        <tr :class="{ active: active_bounds === 'user' }">
          <td class="py-2">
            <input
              type="radio"
              id="user_bounds"
              value="user"
              v-model="picked_bounds"
            /><label for="user_bounds">user</label>
          </td>
          <td class="py-1">
            <input size="10" class="input" v-model.number="user_bounds_low" />
          </td>
          <td class="right py-1">
            <input size="10" class="input" v-model.number="user_bounds_high" />
          </td>
        </tr>
        <tr>
          <td>
            <input
              class="mb-3"
              type="radio"
              id="auto_bounds"
              value="auto"
              v-model="picked_bounds"
            /><label for="auto_bounds">auto</label>
          </td>
          <td></td>
          <td class="right"></td>
        </tr>
        <tr class="py-2">
          <td>
            <div class="select">
              <select class="form-control" v-model="colormap">
                <option v-for="cm in modelInfo.colormaps" :value="cm" :key="cm">
                  {{ cm }}
                </option>
              </select>
            </div>
          </td>
          <td colspan="2" class="py-2">
            <ColorBar
              class="hcolormap"
              :colormap="colormap"
              :invertColormap="invert_colormap"
              orientation="horizontal"
            />
          </td>
        </tr>
        <tr>
          <td>
            <input
              type="checkbox"
              v-model="invert_colormap"
              id="invert_colormap"
            /><label for="invert_colormap">invert</label>
          </td>
          <td></td>
          <td>
            <input
              type="checkbox"
              v-model="auto_colormap"
              id="auto_colormap"
            /><label for="auto_colormap">auto</label>
          </td>
        </tr>
      </table>
    </div>
    <div
      class="panel-block"
      :class="{ 'is-hidden': menu_collapsed }"
      v-if="modelInfo"
    >
      <p class="control">
        <input
          type="checkbox"
          v-model="enable_coastlines"
          id="enable_coastlines"
        /><label for="enable_coastlines">coastlines</label>
      </p>
      <p class="control">
        <button class="button" @click="() => $emit('onRotate')">
          <i class="fa-solid fa-rotate mr-1"></i>
          Toggle Rotation
        </button>
      </p>
    </div>
    <div
      class="panel-block"
      :class="{ 'is-hidden': menu_collapsed }"
      v-if="modelInfo"
    >
      <p class="control">
        <button class="button mb-2" @click="() => $emit('onSnapshot')">
          <i class="fa-solid fa-image mr-1"></i> Snapshot
        </button>
        <button class="button" @click="() => $emit('onExample')">
          <i class="fa-solid fa-clipboard mr-1"></i>
          Copy Python example to clipboard
        </button>
      </p>
    </div>
  </nav>
</template>

<style>
table tr td.right,
table tr th.right {
  text-align: right;
}

table tr.active {
  background-color: lightgreen;
}

.hcolormap {
  width: 15em;
  height: 1.5em;
  max-height: 1.5em;
  overflow: hidden;
}
</style>
