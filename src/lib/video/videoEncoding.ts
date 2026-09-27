export const VIDEO_FORMAT = { FFV1: "ffv1", MP4: "mp4" } as const;
export type TVideoFormat = (typeof VIDEO_FORMAT)[keyof typeof VIDEO_FORMAT];
export const VIDEO_FORMAT_INFO = {
  [VIDEO_FORMAT.FFV1]: { extension: "mkv", mime: "video/x-matroska" },
  [VIDEO_FORMAT.MP4]: { extension: "mp4", mime: "video/mp4" },
} as const;
export const VIDEO_STAGE = {
  LOADING: "Loading video encoder",
  RENDERING: "Rendering frames",
  ENCODING: "Encoding frames",
  FINALIZING: "Finalizing video",
} as const;
export type TVideoProgress = {
  stage: (typeof VIDEO_STAGE)[keyof typeof VIDEO_STAGE];
  completed: number;
  total: number;
  encodedBytes: number;
};
export type TVideoSettings = {
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  format: TVideoFormat;
};

export function videoLayout(settings: TVideoSettings) {
  const { width, height, frameCount, fps, format } = settings;
  if (
    ![width, height, frameCount].every(
      (n) => Number.isSafeInteger(n) && n > 0
    ) ||
    !Number.isFinite(fps) ||
    fps < 1 ||
    fps > 60 ||
    !Object.values(VIDEO_FORMAT).includes(format)
  ) {
    throw new Error(
      "Choose valid video dimensions, frame count and FPS (1–60)."
    );
  }
  // H.264's widely supported YUV420 format requires even dimensions.
  const w = format === VIDEO_FORMAT.MP4 ? width + (width % 2) : width;
  const h = format === VIDEO_FORMAT.MP4 ? height + (height % 2) : height;
  const frameBytes = w * h * 4;
  // ponytail: Bound raw batches to 32 MiB (or one larger frame). Encoded
  // segments and the final download remain buffered; streaming needs a new sink.
  const batchFrames = Math.max(
    1,
    Math.min(30, Math.floor((32 * 1024 ** 2) / frameBytes))
  );
  return { width: w, height: h, frameBytes, batchFrames };
}

export function videoSegmentArgs(settings: TVideoSettings) {
  const { width, height } = videoLayout(settings);
  const codec =
    settings.format === VIDEO_FORMAT.FFV1
      ? ["-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra"]
      : [
          "-vf",
          "scale=in_range=full:out_range=limited:out_color_matrix=bt709",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-bf",
          "0",
        ];
  return [
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(settings.fps),
    "-i",
    "input.rgba",
    "-an",
    ...codec,
    "-color_range",
    settings.format === VIDEO_FORMAT.FFV1 ? "pc" : "tv",
    "-colorspace",
    settings.format === VIDEO_FORMAT.FFV1 ? "rgb" : "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "iec61966-2-1",
    "segment.nut",
  ];
}

export function videoJoinArgs(format: TVideoFormat) {
  return [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    "frames.txt",
    "-c",
    "copy",
    ...(format === VIDEO_FORMAT.MP4 ? ["-movflags", "+faststart"] : []),
    `output.${VIDEO_FORMAT_INFO[format].extension}`,
  ];
}
