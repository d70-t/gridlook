<script setup lang="ts">
import { ref } from "vue";

const visible = ref(false);
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal is-active">
      <div class="modal-background" @click.self="visible = false"></div>
      <div class="modal-card">
        <header class="modal-card-head">
          <p class="modal-card-title">About Gridlook</p>
          <button
            type="button"
            class="delete"
            aria-label="close"
            @click="visible = false"
          ></button>
        </header>
        <section class="modal-card-body">
          <p>
            GridLook is a WebGL-based viewer for Earth system model (ESM)
            output. It supports cloud-hosted Zarr datasets and provides
            interactive grid visualization tools.
          </p>
          <br />
          <p>
            Developed by Max-Planck-Institute for Meteorology (MPI-M) and the
            German Climate Computing Center (DKRZ)
          </p>
        </section>
        <footer class="modal-card-foot">
          <p>
            <a
              href="https://github.com/d70-t/gridlook"
              target="_blank"
              rel="noopener noreferrer"
              class="button is-link is-light"
            >
              <span class="icon">
                <i class="fa-brands fa-github"></i>
              </span>
              <span>View on GitHub</span>
            </a>
          </p>
        </footer>
      </div>
    </div>
  </Teleport>
  <button
    class="button is-info is-small"
    aria-label="About"
    type="button"
    @click="visible = true"
  >
    <span class="icon">
      <i class="fa-solid fa-circle-question"></i>
    </span>
    <span>About</span>
  </button>
</template>
