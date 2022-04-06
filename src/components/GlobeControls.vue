<script setup>
    import ColorBar from '@/components/ColorBar.vue';
</script>

<script>
    export default {
      props: ["modelInfo", "varinfo"],
      emits: ["selection", "onSnapshot", "onExample"],
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
          default_bounds: {low: undefined, high: undefined},
          user_bounds_low: undefined,
          user_bounds_high: undefined,
          picked_bounds: "data",
          view: {},
        }
      },
      watch: {
        time_index() {
            this.publish();
        },
        varname() {
            const varinfo = this.modelInfo.vars[this.varname];
            this.default_bounds = varinfo.default_range || {low: undefined, high: undefined};
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
                this.varname = this.modelInfo.default_var || Object.keys(this.modelInfo.vars)[0];
            }
        }
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
        }
      },
      computed: {
        bounds() {
          if (this.picked_bounds == "data") {
            return this.data_bounds;
          }
          else if (this.picked_bounds == "default") {
            return this.default_bounds;
          }
          else if (this.picked_bounds == "user") {
            return {low: this.user_bounds_low, high: this.user_bounds_high};
          }
        },
        data_bounds() {
            if (this.varinfo && this.varinfo.bounds) {
                return this.varinfo.bounds;
            } else {
                return {low: undefined, high: undefined};
            }
        },
        time_range() {
            if (this.varinfo && this.varinfo.time_range) {
                return this.varinfo.time_range;
            } else {
                return {start: 0, end: 1};
            }
        },
        current_time_index() {
            if (this.varinfo && this.varinfo.time_index) {
                return this.varinfo.time_index;
            } else {
                return undefined;
            }
        },
        current_var_name() {
            if (this.varinfo && this.varinfo.varname) {
                return this.varinfo.varname;
            } else {
                return "-";
            }
        },
        current_var_longname() {
            if (this.varinfo && this.varinfo.attrs && this.varinfo.attrs.long_name) {
                return this.varinfo.attrs.long_name;
            } else {
                return "-";
            }
        },
        current_var_units() {
            if (this.varinfo && this.varinfo.attrs && this.varinfo.attrs.units) {
                return this.varinfo.attrs.units;
            } else {
                return "-";
            }
        },
      }
  }
</script>

<template>
    <nav class="panel gl_controls" id="main_controls">
      <div class="panel-heading" style="display: flex; justify-content: space-between;">
      <div v-if="modelInfo">
      {{ modelInfo.title }}
      </div>
      <div v-else>
      no data available
      </div>
      <div>
          <i class="fa-solid" :class="{'fa-angle-down': menu_collapsed, 'fa-angle-up': !menu_collapsed}" @click="toggle_collapsed"></i>
      </div>
      </div>
      <div class="panel-block" :class="{'is-hidden': menu_collapsed}" v-if="modelInfo">
        <select class="form-control" v-model="varname">
          <option v-for="varname in Object.keys(modelInfo.vars)" :value="varname" :key="varname">{{ varname }}</option>
        </select>
      </div>
      <div class="panel-block" :class="{'is-hidden': menu_collapsed}" v-if="modelInfo">
        <p class="control">
        time: {{ time_index }} / {{ time_range.end }}
        <input class="input"
               type="range"
               v-bind:min="time_range.start"
               v-bind:max="time_range.end"
               v-model.number="time_index"/>
        currently shown: {{ current_var_name }} @ {{ current_time_index }} <br/>
        {{ current_var_longname }} / {{ current_var_units }}
        </p>
      </div>
      <div class="panel-block" :class="{'is-hidden': menu_collapsed}" v-if="modelInfo">
        <table>
            <tr>
                <th>range</th><th>low</th><th class="right">high</th>
            </tr>
            <tr>
                <td><input type="radio" id="data_bounds" value="data" v-model="picked_bounds" /><label for="data_bounds">data</label></td>
                <td>{{ Number(data_bounds.low).toPrecision(4) }}</td>
                <td class="right">{{ Number(data_bounds.high).toPrecision(4) }}</td>
            </tr>
            <tr>
                <td><input type="radio" id="default_bounds" value="default" v-model="picked_bounds" /><label for="default_bounds">default</label></td>
                <td>{{ Number(default_bounds.low).toPrecision(2) }}</td>
                <td class="right">{{ Number(default_bounds.high).toPrecision(2) }}</td>
            </tr>
            <tr>
                <td><input type="radio" id="user_bounds" value="user" v-model="picked_bounds" /><label for="user_bounds">user</label></td>
                <td><input size="10" v-model.number="user_bounds_low"/></td>
                <td class="right"><input size="10" v-model.number="user_bounds_high"/></td>
            </tr>
            <tr>
                <td>
                    <select class="form-control" v-model="colormap">
                      <option v-for="cm in modelInfo.colormaps" :value="cm" :key="cm">{{ cm }}</option>
                    </select>
                </td><td colspan="2"><ColorBar class="hcolormap" :colormap="this.colormap" :invertColormap="this.invert_colormap" orientation="horizontal" /></td>
            </tr>
            <tr>
                <td>
                    <input type="checkbox" v-model="invert_colormap" id="invert_colormap"/><label for="invert_colormap">invert</label>
                </td>
                <td></td>
                <td></td>
            </tr>
        </table>
      </div>
      <div class="panel-block" :class="{'is-hidden': menu_collapsed}" v-if="modelInfo">
        <p class="control">
        <input type="checkbox" v-model="enable_coastlines" id="enable_coastlines"/><label for="enable_coastlines">coastlines</label>
        </p>
        <p class="control">
        <button @click="() => $emit('onSnapshot')">Snapshot</button>
        <button @click="() => $emit('onExample')">copy Python example to clipboard</button>
        </p>
      </div>
    </nav>
</template>

<style>
table tr td.right, table tr th.right {
    text-align: right;
}

.hcolormap {
    width: 15em;
    height: 1.5em;
    max-height: 1.5em;
    overflow: hidden;
}
</style>
