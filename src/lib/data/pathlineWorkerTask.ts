import { Grid, type GridOptions } from "healpix-geo";

import {
  createPathlineGrid,
  PATHLINE_GRID,
  samplePathlineTime,
  type TPathlineGrid,
  type TPathlineValues,
} from "./pathlineField.ts";
import {
  integratePathlines,
  type TPathlineConfig,
  type TPathlineInputs,
} from "./pathlineTrajectories.ts";

type TWorkerGrid =
  | Exclude<TPathlineGrid, { kind: typeof PATHLINE_GRID.HEALPIX }>
  | {
      kind: typeof PATHLINE_GRID.HEALPIX;
      options: GridOptions;
      cells?: number[];
    };
export type TPathlineWorkerInput = {
  grid: TWorkerGrid;
  times: readonly number[];
  fields: TPathlineValues[];
};
export type TPathlineWorkerTask = TPathlineWorkerInput & {
  config: TPathlineConfig;
  start: number;
  end: number;
  warmup?: boolean;
};
/** WASM grid handles and sampler closures cannot be cloned into a worker. */
export function pathlineWorkerGrid(grid: TPathlineGrid): TWorkerGrid {
  if (grid.kind !== PATHLINE_GRID.HEALPIX) {
    return { ...grid };
  }
  const { semiMajorAxis, flattening, scheme, level } = grid.grid;
  return {
    kind: grid.kind,
    cells: grid.cells?.slice(),
    options: {
      scheme,
      level,
      ellipsoid:
        flattening === 0
          ? { radius: semiMajorAxis }
          : {
              // eslint-disable-next-line camelcase -- healpix-geo input keys
              semi_major_axis: semiMajorAxis,
              // eslint-disable-next-line camelcase -- healpix-geo input keys
              inverse_flattening: 1 / flattening,
            },
    },
  };
}

export async function runPathlineWorkerTask(
  task: TPathlineWorkerTask,
  onProgress?: (completed: number) => void,
  onTiming?: (milliseconds: number) => void
) {
  using hp =
    task.grid.kind === PATHLINE_GRID.HEALPIX
      ? new Grid(task.grid.options)
      : undefined;
  const grid = createPathlineGrid(
    task.grid.kind === PATHLINE_GRID.HEALPIX
      ? { kind: task.grid.kind, grid: hp!, cells: task.grid.cells }
      : task.grid
  );
  const fields = task.fields.map(({ u, v, gridRelative }) =>
    grid.field(u, v, gridRelative)
  );
  const inputs: TPathlineInputs = {
    sourceTimes: task.times,
    sample: (lat, lon, time) =>
      samplePathlineTime(task.times, fields, lat, lon, time),
    seedPosition: grid.seedPosition,
    surface: hp
      ? { semiMajorAxis: hp.semiMajorAxis, flattening: hp.flattening }
      : undefined,
  };
  if (task.warmup) {
    // Warm the sampler/solver without scaling startup or JIT work to the job.
    await integratePathlines(
      inputs,
      {
        ...task.config,
        particleCount: Math.min(64, task.config.particleCount),
      },
      { yieldToUI: false }
    );
  }
  const started = performance.now();
  const result = await integratePathlines(inputs, task.config, {
    particleStart: task.start,
    particleEnd: task.end,
    yieldToUI: false,
    onProgress,
  });
  onTiming?.(performance.now() - started);
  return result;
}
