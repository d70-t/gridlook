/**
 * Planning a plot: its kind's planner, in slices for date ranges, after the
 * cells are weighed. Its own module, so the planners of every kind
 * (operations.ts, spaceTimeOperations.ts) are imported here and neither imports
 * the other's entry point.
 */
import { AnalysisInputError } from "./analysisErrors.ts";
import { type ReadContext, SHARD_INDEX_BYTES } from "./chunkVisitor.ts";
import { weightComparisonCost } from "./jointComponents.ts";
import { type TNativeContext } from "./nativeGrid.ts";
import {
  AREA_WEIGHTED_KINDS,
  COLD_GEOMETRY_CONFIRM,
  MAX_GEOMETRY_READS,
  MODEST_BYTES,
  MODEST_CHUNKS,
  admit,
  admitNativeGeometry,
  chunkBytesOf,
  coldAtlas,
  cornerAreaReads,
  count,
  declaredAreaReads,
  mib,
  planPointSeries,
  planProfile,
  planRegionSeries,
  planSection,
  timeOf,
  type TPlannedAnalysis,
} from "./operations.ts";
import {
  planDistribution,
  planLatVertical,
  planLonVertical,
  planHovmollerBand,
  planHovmollerPath,
  planTimeDepth,
} from "./spaceTimeOperations.ts";
import { planInSlices } from "./timeSelection.ts";
import {
  ANALYSIS_KINDS,
  MAX_WORKING_BYTES,
  type TAnalysisQuery,
  type TPlanEstimate,
  TIME_RANGE_KINDS,
} from "./types.ts";
import {
  ANALYSIS_GRID_KINDS,
  readSelectedLeads,
  type TVariableContext,
} from "./variableContext.ts";

/** Resolve geometry and chunk lists for a query; reads happen in execute. */
// eslint-disable-next-line max-lines-per-function
export async function planAnalysis(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal,
  /** The user chose Locate cells: load the geometry now and estimate the field. */
  geometryConfirmed = false,
  /** The other vector component's context, for `query.jointWith`. */
  partner?: TVariableContext
): Promise<TPlannedAnalysis> {
  const capability = context.capabilities[query.kind];
  if (!capability.available) {
    throw new AnalysisInputError(
      capability.reason ?? "Not available for this variable."
    );
  }
  admitNativeGeometry(context);
  // A long forecast period axis is read at the lead fixed, one chunk.
  await readSelectedLeads(context, query, signal);
  // The finest atlas parsed first is priced and asked about before it is parsed
  // (areas are counted on its cells); coarser ones are said.
  const atlas = coldAtlas(context, query.geometry);
  if (
    atlas &&
    atlas.characters > MODEST_ATLAS_CHARACTERS &&
    !geometryConfirmed
  ) {
    return atlasFirst(context, query, read, signal, partner, atlas);
  }
  // A sibling store's areas: its coordinates checked for area plots only,
  // priced first with everything else the cells need, in one budget.
  const areas =
    context.grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR &&
    AREA_WEIGHTED_KINDS.includes(query.kind)
      ? context.grid.areas
      : undefined;
  const verifying = (await areas?.verifyCost?.()) ?? { reads: 0, bytes: 0 };
  // Taken before planning, since locators load the geometry while planning.
  const cornerReads = cornerAreaReads(context, query.kind);
  // A vector's partner in another store: its cells are compared with ours.
  const partnerGeometry =
    partner?.grid.kind === ANALYSIS_GRID_KINDS.NATIVE &&
    context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE &&
    partner.grid.regionKey !== context.grid.regionKey &&
    !partner.grid.geometryReady()
      ? {
          reads: partner.grid.geometryReadsNow(),
          bytes: partner.grid.geometryBytes,
        }
      : { reads: 0, bytes: 0 };
  // Both cell geometries are held together while the vector is reduced:
  // admitted together, loaded or not.
  if (
    partner?.grid.kind === ANALYSIS_GRID_KINDS.NATIVE &&
    context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE &&
    partner.grid.regionKey !== context.grid.regionKey &&
    context.grid.geometryBytes + partner.grid.geometryBytes > MAX_WORKING_BYTES
  ) {
    throw new AnalysisInputError(
      `The two components' cell coordinates and outlines need about ${mib(context.grid.geometryBytes + partner.grid.geometryBytes)} in memory together; plots use at most ${mib(MAX_WORKING_BYTES)}.`
    );
  }
  // What a cold axis locator fetches before it answers: its sides' whole
  // stored chunks and shard indexes, however few values they hold.
  const locatorFetch =
    context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE
      ? (context.grid.geometryBytesNow?.() ?? 0)
      : 0;
  const geometryReads =
    (context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE
      ? context.grid.geometryReadsNow()
      : 0) +
    cornerReads +
    partnerGeometry.reads;
  // Areas whose first load decodes much, in however few chunks (AWI: two corner
  // chunks, 203 MiB), or reads many (a rectilinear grid's declared areas in
  // small chunks: 1,147 for Germany): priced before any is read, as many
  // coordinate reads are. Counted (and limited) when confirmed too; then no
  // longer asked about.
  const counted = await declaredAreaReads(context, query, signal);
  // A vector's two declared measures compared whole: priced with them.
  const comparing =
    query.jointWith &&
    areas &&
    partner?.grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR
      ? weightComparisonCost(areas, partner.grid.areas)
      : { reads: 0, bytes: 0, largest: 0 };
  const allReads =
    geometryReads + counted.reads + verifying.reads + comparing.reads;
  if (allReads > MAX_GEOMETRY_READS) {
    throw new AnalysisInputError(
      `Locating and weighing these cells would first read ${count(allReads)} stored chunks of coordinates and areas${verifying.reads ? ` (${count(verifying.reads)} of them to check that the declared cell areas ${areas!.name} are on this grid)` : ""}; plots read at most ${count(MAX_GEOMETRY_READS)}. Points still work (they need no areas).`
    );
  }
  const declared = geometryConfirmed
    ? { reads: 0, bytes: 0 }
    : {
        reads: counted.reads + verifying.reads + comparing.reads,
        bytes: counted.bytes + verifying.bytes + comparing.bytes,
      };
  const areaBytes =
    (cornerReads && context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE
      ? (context.grid.cornerAreas?.bytes ?? 0)
      : 0) + declared.bytes;
  const areaReads = geometryReads + declared.reads;
  // Areas are held while the cells are weighed: past the working limit they are
  // refused before any is read, confirmed or not.
  const heldAreas =
    (cornerReads && context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE
      ? (context.grid.cornerAreas?.bytes ?? 0)
      : 0) + counted.held;
  // While the last area tile is converted, its stored chunk is held beside
  // every tile already converted.
  const converting =
    heldAreas +
    Math.max("input" in counted ? counted.input : 0, comparing.largest);
  if (converting > MAX_WORKING_BYTES) {
    throw new AnalysisInputError(
      `Weighing these cells needs about ${mib(converting)} of cell areas in memory while they are read; plots use at most ${mib(MAX_WORKING_BYTES)}. Choose a smaller area, or plot a point.`
    );
  }
  // With at least one field chunk read beside them, before any is read.
  if (counted.held && heldAreas + chunkBytesOf(context) > MAX_WORKING_BYTES) {
    throw new AnalysisInputError(
      `Weighing these cells holds about ${mib(heldAreas)} of cell areas while each stored chunk of the field (${mib(chunkBytesOf(context))}) is read; plots use at most ${mib(MAX_WORKING_BYTES)}. Choose a smaller area, or plot a point.`
    );
  }
  // What the area reads decode (their chunks), apart from the memory the pass
  // holds.
  const areaDecoded =
    (cornerReads && context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE
      ? (context.grid.cornerAreas?.decodedNow() ?? 0)
      : 0) +
    declared.bytes +
    locatorFetch;
  // A cold locator that decodes much in few chunks is asked about too. A loaded
  // one costs nothing more.
  const locatorBytes =
    (context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE &&
    !context.grid.geometryReady()
      ? context.grid.geometryBytes
      : 0) +
    partnerGeometry.bytes +
    locatorFetch;
  if (
    !geometryConfirmed &&
    (areaReads > COLD_GEOMETRY_CONFIRM ||
      areaBytes > MODEST_BYTES ||
      locatorBytes > MODEST_BYTES)
  ) {
    // Many cold coordinate reads come first: ask before making any.
    return deferredPlan(
      context,
      query,
      read,
      areaReads,
      signal,
      { held: areaBytes, decoded: areaDecoded, coordinates: locatorFetch },
      partner,
      (signal) => areas?.verify?.(signal)
    );
  }
  // Priced above: the sibling's coordinates are checked now.
  await areas?.verify?.(signal);
  const planned = await planKindInSlices(context, query, read, signal, partner);
  if (atlas) {
    planned.estimate.notes.push(atlasNote(atlas));
  }
  withShardIndexes(context, planned.estimate, query, partner);
  // The weights stay held while the field is read: both together within the
  // working limit.
  if (counted.held) {
    const { estimate } = planned;
    estimate.workingBytes += counted.held;
    admit(
      chunkBytesOf(context),
      estimate.chunks,
      estimate.outputValues,
      estimate.workingBytes
    );
  }
  // Declared areas read while planning count with the field reads.
  const coldReads = geometryReads + declared.reads;
  if (coldReads && !geometryConfirmed) {
    const { estimate } = planned;
    estimate.geometryReads = coldReads;
    // Cold coordinate reads are requests too, and a corner pass decodes far
    // more than its few requests suggest (AWI: 2 chunks, 203 MiB). What
    // weighing decodes is decoded too: 60 MiB of areas beside a 60 MiB field is
    // 120 MiB.
    estimate.decodedBytes += areaDecoded;
    estimate.modest &&=
      estimate.decodedBytes <= MODEST_BYTES &&
      estimate.chunks + coldReads <= MODEST_CHUNKS &&
      !(
        cornerReads &&
        context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE &&
        (context.grid.cornerAreas?.bytes ?? 0) > MODEST_BYTES
      );
  }
  return planned;
}

/** Atlas data parsed without asking first (the 1:50m one and coarser). */
const MODEST_ATLAS_CHARACTERS = 1_000_000;

function atlasNote(atlas: { resolution: string; characters: number }) {
  return `Choosing the cells first prepares the 1:${atlas.resolution.replace("m", "")} million country boundaries (about ${mib(atlas.characters)} of bundled atlas data, parsed once per session).`;
}

/**
 * A country plot whose atlas is not prepared yet: asked about before the
 * atlas is parsed; once confirmed, planned and run (declining parses
 * nothing).
 */
function atlasFirst(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  planSignal: AbortSignal | undefined,
  partner: TVariableContext | undefined,
  atlas: { resolution: string; characters: number }
): TPlannedAnalysis {
  return {
    estimate: {
      chunks: 0,
      decodedBytes: 0,
      // The parsed atlas held while its country's rings are made.
      workingBytes: 4 * atlas.characters,
      outputValues: 0,
      modest: false,
      needsConfirmation: true,
      notes: [
        `${atlasNote(atlas)} The field reads are counted once the cells are known.`,
      ],
    },
    async execute(signal, hooks) {
      const planned = await planAnalysis(
        context,
        query,
        read,
        signal ?? planSignal,
        true,
        partner
      );
      return planned.execute(signal, hooks);
    },
  };
}

/**
 * A plan whose geometry is not loaded and would need many reads: its
 * estimate is known without reading anything, and its execution (after
 * the user confirms) plans and then runs. Declining reads nothing.
 */
function deferredPlan(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  geometryReads: number,
  planSignal?: AbortSignal,
  /**
   * What weighing the cells first decodes (their areas), if anything, and
   * the memory that pass holds.
   */
  areas: { held: number; decoded: number; coordinates?: number } = {
    held: 0,
    decoded: 0,
  },
  partner?: TVariableContext,
  /** What is checked first once confirmed (a sibling's coordinates). */
  before?: (signal?: AbortSignal) => Promise<void> | undefined
): TPlannedAnalysis {
  const grid = context.grid as TNativeContext;
  const areaBytes = areas.held;
  return {
    estimate: {
      chunks: 0,
      decodedBytes: areas.decoded,
      // A rectilinear grid's areas: no native geometry.
      workingBytes: Math.max(
        grid.kind === ANALYSIS_GRID_KINDS.NATIVE ? grid.geometryBytes : 0,
        areaBytes
      ),
      outputValues: 0,
      geometryReads,
      modest: false,
      needsConfirmation: true,
      notes: [
        areaBytes
          ? `Weighing the cells first reads their areas: ${count(geometryReads)} chunks decoding about ${mib(areas.decoded - (areas.coordinates ?? 0))}${areas.coordinates ? `, and about ${mib(areas.coordinates)} of stored coordinates` : ""}${areaBytes > areas.decoded ? `, up to about ${mib(areaBytes)} in memory while they are read` : ""}; the field reads are counted once the cells are known.`
          : `Locating cells first reads ${count(geometryReads)} coordinate chunks${areas.coordinates ? ` (about ${mib(areas.coordinates)} stored, shard indexes included)` : ""}${grid.kind === ANALYSIS_GRID_KINDS.NATIVE && grid.geometryBytes > MODEST_BYTES ? ` and holds about ${mib(grid.geometryBytes)} of coordinates and outlines in memory` : ""}; the field reads are counted once the cells are known.`,
      ],
    },
    async execute(signal, hooks) {
      await before?.(signal ?? planSignal);
      const planned = await planKindInSlices(
        context,
        query,
        read,
        signal ?? planSignal,
        partner
      );
      return planned.execute(signal, hooks);
    },
  };
}

/**
 * The shards of `array` a plan's `reads` chunk reads touch: `distinct`,
 * and `passes`, the index reads when each stored time chunk's pass reads
 * its cells' indexes again (more than the page keeps).
 */
function shardsTouched(
  array: TVariableContext["array"],
  index: NonNullable<TVariableContext["array"]["shardIndex"]>,
  reads: number,
  query: TAnalysisQuery,
  time?: number
) {
  const { shape, chunks } = array;
  const along = (d: number) =>
    Math.max(
      1,
      Math.ceil(shape[d] / Math.max(1, chunks[d] * index.chunksPerShard[d]))
    );
  const shards = shape.reduce((p, _, d) => p * along(d), 1);
  if (time === undefined || !query.time) {
    const distinct = Math.min(reads, shards);
    return { distinct, passes: reads };
  }
  const chunk = Math.max(1, chunks[time]);
  const shard = chunk * Math.max(1, index.chunksPerShard[time]);
  const runs = query.time.runs?.length
    ? query.time.runs
    : [[query.time.start, query.time.stop] as [number, number]];
  const distinctAlong = (size: number) => {
    let [count, last] = [0, -1];
    for (const [start, stop] of runs) {
      const [a, b] = [Math.floor(start / size), Math.floor((stop - 1) / size)];
      count += Math.max(0, b - Math.max(a, last + 1) + 1);
      last = Math.max(last, b);
    }
    return Math.max(1, count);
  };
  const timeChunks = distinctAlong(chunk);
  const timeShards = distinctAlong(shard);
  const cells = Math.min(
    Math.max(1, Math.ceil(reads / timeChunks)),
    Math.max(1, shards / along(time))
  );
  return {
    distinct: Math.min(timeShards * cells, shards),
    passes: Math.max(Math.min(reads, timeChunks * cells), timeShards * cells),
  };
}

/**
 * The shards a selection's runs touch: along each axis those its runs
 * reach, multiplied; and its passes, each stored time chunk's pass reading
 * its cells' shards again.
 */
function shardsOfRuns(
  array: TVariableContext["array"],
  index: NonNullable<TVariableContext["array"]["shardIndex"]>,
  runs: [number, number][][],
  time?: number
) {
  const distinctAlong = (list: [number, number][], size: number) => {
    const sorted = [...list].sort((a, b) => a[0] - b[0]);
    let [count, last] = [0, -1];
    for (const [start, stop] of sorted) {
      if (stop <= start) {
        continue;
      }
      const [a, b] = [Math.floor(start / size), Math.floor((stop - 1) / size)];
      count += Math.max(0, b - Math.max(a, last + 1) + 1);
      last = Math.max(last, b);
    }
    return count;
  };
  let [distinct, spatial, timeChunks] = [1, 1, 1];
  array.shape.forEach((n, d) => {
    const list = runs[d]?.length ? runs[d] : [[0, n] as [number, number]];
    const chunk = Math.max(1, array.chunks[d] ?? n);
    const shard = chunk * Math.max(1, index.chunksPerShard[d] ?? 1);
    const shards = Math.max(1, distinctAlong(list, shard));
    distinct *= shards;
    if (d === time) {
      timeChunks = Math.max(1, distinctAlong(list, chunk));
    } else {
      spatial *= shards;
    }
  });
  return { distinct, passes: Math.max(distinct, timeChunks * spatial) };
}

/**
 * The shard indexes a sharded field's chunks are found through: fetched and
 * held before any value of their shard is read. Counted as the shards the
 * selection touches: its stored time chunks' shards along time, times the
 * shards of its cells. Past the indexes the page keeps, every date's pass reads
 * them again: then the price is that bound, said as one (a Box of 80 shards
 * over 12 dates was quoted 80 MiB and read 384 MiB).
 */
// eslint-disable-next-line max-lines-per-function
function withShardIndexes(
  context: TVariableContext,
  estimate: TPlanEstimate,
  query: TAnalysisQuery,
  partner?: TVariableContext
) {
  const own = estimate.chunks - (estimate.termChunks ?? 0);
  const runs = estimate.shardRuns;
  delete estimate.shardRuns;
  const arrays = [
    {
      array: context.array,
      chunks: own,
      time: context.time?.axis,
      runs: runs?.own,
    },
    // A vector's partner reads through its own shard indexes too, at its own
    // rows.
    ...(partner && partner.array !== context.array
      ? [
          {
            array: partner.array,
            chunks: estimate.termChunks ?? (runs?.partner ? own : 0),
            time: partner.time?.axis,
            runs: runs?.partner,
          },
        ]
      : []),
  ];
  const priced: { distinct: number; passes: number; bytes: number }[] = [];
  let largest = 0;
  for (const [
    at,
    { array, chunks: reads, time, runs: own },
  ] of arrays.entries()) {
    const index = array.shardIndex;
    if (!index || reads <= 0) {
      continue;
    }
    // One index larger than all the page keeps of them is refused before it is
    // asked for.
    if (index.bytes > SHARD_INDEX_BYTES) {
      throw new AnalysisInputError(
        `Each shard of ${array.key.split("|").at(-1) ?? "this field"} has an index of ${mib(index.bytes)}, read before any of its values; plots keep at most ${mib(SHARD_INDEX_BYTES)} of shard indexes.`
      );
    }
    const counted = shardsTouched(array, index, reads, query, time);
    // From the runs read, where known: adjacent chunks of one shard are one
    // index.
    const exact = own ? shardsOfRuns(array, index, own, time) : undefined;
    // The partner's by its own rows alone: the query's dates are ours.
    const touched =
      exact && at > 0
        ? exact
        : exact
          ? {
              distinct: Math.min(exact.distinct, counted.distinct),
              passes: Math.min(exact.passes, counted.passes),
            }
          : counted;
    priced.push({ ...touched, bytes: index.bytes });
    largest = Math.max(largest, index.bytes);
  }
  // All the arrays' indexes against the one page-wide budget together.
  const together = priced.reduce((t, p) => t + p.distinct * p.bytes, 0);
  const again = together > SHARD_INDEX_BYTES;
  const bytes = again
    ? priced.reduce((t, p) => t + p.passes * p.bytes, 0)
    : together;
  if (!bytes) {
    return;
  }
  estimate.decodedBytes += bytes;
  estimate.workingBytes += Math.min(bytes, SHARD_INDEX_BYTES + largest);
  estimate.modest &&= estimate.decodedBytes <= MODEST_BYTES;
  estimate.notes.push(
    again
      ? `Its values are found through shard indexes, more than the ${mib(SHARD_INDEX_BYTES)} kept of them: each date's pass may read them again, up to ${mib(bytes)}.`
      : `Its values are found through shard indexes: up to ${mib(bytes)} of them are read first.`
  );
  admit(
    chunkBytesOf(context),
    estimate.chunks,
    estimate.outputValues,
    estimate.workingBytes
  );
}

/** A plan for the query, a slice at a time when its dates are in several. */
function planKindInSlices(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal,
  partner?: TVariableContext
) {
  // One-date plots read their `start`: slices are for date ranges.
  if (!TIME_RANGE_KINDS.includes(query.kind)) {
    return planKind(context, query, read, signal, partner);
  }
  return planInSlices(
    query,
    (slice) => planKind(context, slice, read, signal, partner),
    (start, stop) => timeOf(context, start, stop),
    {
      bytes: MODEST_BYTES,
      chunks: MODEST_CHUNKS,
      timeChunk: context.time && context.array.chunks[context.time.axis],
      cacheBytes: read.chunkCache.budget,
      admit: ({ chunks, outputValues, workingBytes }) =>
        admit(chunkBytesOf(context), chunks, outputValues, workingBytes),
    }
  );
}

function planKind(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal,
  partner?: TVariableContext
): Promise<TPlannedAnalysis> {
  switch (query.kind) {
    case ANALYSIS_KINDS.POINT_SERIES:
      return planPointSeries(context, query, read, signal);
    case ANALYSIS_KINDS.REGION_SERIES:
      return planRegionSeries(context, query, read, signal, partner);
    case ANALYSIS_KINDS.PROFILE:
      return planProfile(context, query, read, signal);
    case ANALYSIS_KINDS.SECTION:
      return planSection(context, query, read, signal);
    case ANALYSIS_KINDS.TIME_DEPTH:
      return planTimeDepth(context, query, read, signal);
    case ANALYSIS_KINDS.HOVMOLLER_LON:
    case ANALYSIS_KINDS.HOVMOLLER_LAT:
      return planHovmollerBand(context, query, read, signal);
    case ANALYSIS_KINDS.HOVMOLLER_PATH:
      return planHovmollerPath(context, query, read, signal);
    case ANALYSIS_KINDS.DISTRIBUTION:
      return planDistribution(context, query, read, signal);
    case ANALYSIS_KINDS.LAT_VERTICAL:
      return planLatVertical(context, query, read, signal);
    case ANALYSIS_KINDS.LON_VERTICAL:
      return planLonVertical(context, query, read, signal);
  }
}
