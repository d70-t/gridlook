import {
  pathlinePositionAt,
  type TPathlineTrajectories,
} from "@/lib/data/pathlineTrajectories.ts";

export const PATHLINE_DISPLAY = {
  PREVIEW: "preview",
  TRAJECTORY: "trajectory",
} as const;
export type TPathlineDisplay =
  (typeof PATHLINE_DISPLAY)[keyof typeof PATHLINE_DISPLAY];

export function pathlinePreviewLayout(
  particles: number,
  keyframes: number,
  limit: number
) {
  const shape = (records: number) => {
    const width = Math.min(limit, Math.ceil(Math.sqrt(records)));
    return { width, height: Math.ceil(records / width) };
  };
  const positions = shape(particles * keyframes);
  const lifetimes = shape(particles);
  if (positions.height > limit || lifetimes.height > limit) {
    return;
  }
  return {
    positions,
    lifetimes,
    bytes:
      (positions.width * positions.height +
        lifetimes.width * lifetimes.height) *
      16,
  };
}

/** Derive a cheap display representation once; retain the full trajectories for export. */
export async function packPathlinePreview(
  data: TPathlineTrajectories,
  times: readonly number[],
  layout: NonNullable<ReturnType<typeof pathlinePreviewLayout>>,
  checkpoint: () => Promise<void>
) {
  const positions = new Float32Array(
    layout.positions.width * layout.positions.height * 4
  );
  const lifetimes = new Float32Array(
    layout.lifetimes.width * layout.lifetimes.height * 4
  );
  let samples = 0;
  for (let particle = 0; particle < data.counts.length; particle++) {
    if (particle % 2048 === 0) {
      await checkpoint();
    }
    if (data.counts[particle] < 2) {
      continue;
    }
    const first = particle * data.capacity;
    const birth = data.times[first],
      death = data.times[first + data.counts[particle] - 1];
    const start = birth - data.start,
      end = death - data.start;
    lifetimes.set(
      [
        Math.fround(start),
        start - Math.fround(start),
        Math.fround(end),
        end - Math.fround(end),
      ],
      particle * 4
    );
    for (let frame = 0; frame < times.length; frame++) {
      if (++samples % 2048 === 0) {
        await checkpoint();
      }
      // Clamp to real endpoints so births/deaths inside a keyframe interval can
      // still fade and interpolate correctly, without extending their lifetime.
      const point = pathlinePositionAt(
        data,
        particle,
        Math.max(birth, Math.min(death, times[frame]))
      )!;
      positions.set(point, (frame * data.counts.length + particle) * 4);
    }
  }
  await checkpoint();
  return { positions, lifetimes };
}
