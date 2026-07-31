import { around, distance } from "geokdbush";
import KDBush from "kdbush";

export type TVectorVariablePair = {
  u: string;
  v: string;
  kind: "u/v" | "ua/va" | "uas/vas" | "u10/v10" | "custom";
};

export type TVectorVariableSelection = {
  automatic: boolean;
  u?: string;
  v?: string;
};

type TAxisBracket = {
  lowIndex: number;
  highIndex: number;
  fraction: number;
};

export type TVectorSample = {
  u: number;
  v: number;
  speed: number;
};

export type TStreamlineVectorField = {
  readonly isGlobal: boolean;
  readonly latitudeMin: number;
  readonly latitudeMax: number;
  readonly longitudeMin: number;
  readonly longitudeMax: number;
  readonly referenceSpeed: number;

  sample(latitude: number, longitude: number): TVectorSample | undefined;

  advance(
    latitude: number,
    longitude: number,
    seconds: number
  ): { latitude: number; longitude: number } | undefined;

  randomPosition(random?: () => number): {
    latitude: number;
    longitude: number;
  };
};

const VECTOR_PAIR_NAMES = [
  { u: "u", v: "v", kind: "u/v" },
  { u: "ua", v: "va", kind: "ua/va" },
  { u: "uas", v: "vas", kind: "uas/vas" },
  { u: "u10", v: "v10", kind: "u10/v10" },
] as const;

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

const NATIVE_INTERPOLATION_SAMPLE_COUNT = 4;
const PERIODIC_INDEX_REPLICA_COUNT = 3;

export function getVariableGroup(name: string) {
  const slashIndex = name.lastIndexOf("/");
  return slashIndex === -1 ? "" : name.slice(0, slashIndex);
}

function splitVariableName(name: string) {
  const slashIndex = name.lastIndexOf("/");

  return {
    group: getVariableGroup(name),
    basename: name.slice(slashIndex + 1).toLowerCase(),
  };
}

function collectVariableGroups(variableNames: string[]) {
  const groups = new Map<string, Map<string, string>>();

  for (const name of variableNames) {
    const { group, basename } = splitVariableName(name);
    const variables = groups.get(group) ?? new Map<string, string>();

    if (!variables.has(basename)) {
      variables.set(basename, name);
    }

    groups.set(group, variables);
  }

  return groups;
}

function sortGroups(a: string, b: string, preferredGroup?: string) {
  if (a === preferredGroup) {
    return -1;
  }

  if (b === preferredGroup) {
    return 1;
  }

  if (a === "") {
    return -1;
  }

  if (b === "") {
    return 1;
  }

  return a.localeCompare(b);
}

function sortPairs(
  a: (typeof VECTOR_PAIR_NAMES)[number],
  b: (typeof VECTOR_PAIR_NAMES)[number],
  preferredBasename?: string
) {
  if (a.u === preferredBasename || a.v === preferredBasename) {
    return -1;
  }

  if (b.u === preferredBasename || b.v === preferredBasename) {
    return 1;
  }

  return 0;
}

/** Detect a conventional eastward/northward vector-component pair. */
export function detectVectorVariablePair(
  variableNames: string[],
  preferredVariable?: string
): TVectorVariablePair | undefined {
  const groups = collectVariableGroups(variableNames);

  const preferred = preferredVariable
    ? splitVariableName(preferredVariable)
    : undefined;

  const groupNames = [...groups.keys()].sort((a, b) =>
    sortGroups(a, b, preferred?.group)
  );

  const pairNames = [...VECTOR_PAIR_NAMES].sort((a, b) =>
    sortPairs(a, b, preferred?.basename)
  );

  for (const groupName of groupNames) {
    const variables = groups.get(groupName)!;

    for (const pair of pairNames) {
      const u = variables.get(pair.u);
      const v = variables.get(pair.v);

      if (u && v) {
        return {
          u,
          v,
          kind: pair.kind,
        };
      }
    }
  }

  return undefined;
}

/** Resolve either explicitly selected components or a conventional pair. */
export function resolveVectorVariablePair(
  variableNames: string[],
  preferredVariable: string,
  selection: TVectorVariableSelection
): TVectorVariablePair | undefined {
  const preferredGroup = getVariableGroup(preferredVariable);
  const groupVariableNames = variableNames.filter(
    (name) => getVariableGroup(name) === preferredGroup
  );

  if (selection.automatic) {
    return detectVectorVariablePair(groupVariableNames, preferredVariable);
  }

  if (
    selection.u &&
    selection.v &&
    groupVariableNames.includes(selection.u) &&
    groupVariableNames.includes(selection.v)
  ) {
    return {
      u: selection.u,
      v: selection.v,
      kind: "custom",
    };
  }

  return undefined;
}

function isGlobalLongitudeAxis(longitudes: Float32Array) {
  if (longitudes.length < 2) {
    return false;
  }

  const span = Math.abs(longitudes.at(-1)! - longitudes[0]);

  return span + span / (longitudes.length - 1) > 359.5;
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

function normalizeLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function nearestEquivalentLongitude(longitude: number, reference: number) {
  return longitude + 360 * Math.round((reference - longitude) / 360);
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) {
    return 1;
  }

  values.sort((a, b) => a - b);

  return values[Math.floor((values.length - 1) * fraction)];
}

function calculateReferenceSpeed(uData: Float32Array, vData: Float32Array) {
  const speeds: number[] = [];
  const stride = Math.max(1, Math.floor(uData.length / 10_000));

  for (let i = 0; i < uData.length; i += stride) {
    const u = uData[i];
    const v = vData[i];

    if (Number.isFinite(u) && Number.isFinite(v)) {
      speeds.push(Math.hypot(u, v));
    }
  }

  return Math.max(percentile(speeds, 0.9), Number.EPSILON);
}

function finiteBounds(values: Float32Array) {
  let minimum = Infinity;
  let maximum = -Infinity;

  for (const value of values) {
    if (Number.isFinite(value)) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }

  return {
    minimum,
    maximum,
  };
}

function regularAxis(minimum: number, maximum: number) {
  const count = Math.max(2, Math.ceil(maximum - minimum) + 1);

  return Float32Array.from(
    { length: count },
    (_, index) => minimum + (index * (maximum - minimum)) / (count - 1)
  );
}

function interpolationRadiusKm(
  sampleCount: number,
  latitudeMin: number,
  latitudeMax: number,
  longitudeMin: number,
  longitudeMax: number
) {
  const longitudeSpan =
    Math.min(longitudeMax - longitudeMin, 360) * DEGREES_TO_RADIANS;

  const latitudeFactor = Math.abs(
    Math.sin(latitudeMax * DEGREES_TO_RADIANS) -
      Math.sin(latitudeMin * DEGREES_TO_RADIANS)
  );

  const areaKm2 = 6_371 ** 2 * longitudeSpan * latitudeFactor;
  const typicalSpacing = Math.sqrt(areaKm2 / sampleCount);

  return clamp(typicalSpacing * 4, 200, 1_500);
}

function filterFiniteVectorSamples(
  latitudes: Float32Array,
  longitudes: Float32Array,
  uData: Float32Array,
  vData: Float32Array
) {
  const validIndices: number[] = [];

  for (let i = 0; i < latitudes.length; i++) {
    if (
      Number.isFinite(latitudes[i]) &&
      Number.isFinite(longitudes[i]) &&
      Number.isFinite(uData[i]) &&
      Number.isFinite(vData[i])
    ) {
      validIndices.push(i);
    }
  }

  if (validIndices.length === latitudes.length) {
    return {
      latitudes,
      longitudes,
      uData,
      vData,
    };
  }

  return {
    latitudes: Float32Array.from(validIndices, (index) => latitudes[index]),
    longitudes: Float32Array.from(validIndices, (index) => longitudes[index]),
    uData: Float32Array.from(validIndices, (index) => uData[index]),
    vData: Float32Array.from(validIndices, (index) => vData[index]),
  };
}

type TUnitVector = {
  x: number;
  y: number;
  z: number;
};

function normalizeUnitVector(point: TUnitVector): TUnitVector {
  const length = Math.hypot(point.x, point.y, point.z);

  if (length <= Number.EPSILON) {
    return {
      x: 1,
      y: 0,
      z: 0,
    };
  }

  const inverseLength = 1 / length;

  return {
    x: point.x * inverseLength,
    y: point.y * inverseLength,
    z: point.z * inverseLength,
  };
}

function geographicToUnitVector(
  latitude: number,
  longitude: number
): TUnitVector {
  const latitudeRadians = latitude * DEGREES_TO_RADIANS;
  const longitudeRadians = longitude * DEGREES_TO_RADIANS;
  const cosLatitude = Math.cos(latitudeRadians);

  return {
    x: cosLatitude * Math.cos(longitudeRadians),
    y: cosLatitude * Math.sin(longitudeRadians),
    z: Math.sin(latitudeRadians),
  };
}

function unitVectorToGeographic(point: TUnitVector) {
  const normalized = normalizeUnitVector(point);

  return {
    latitude: Math.asin(clamp(normalized.z, -1, 1)) * RADIANS_TO_DEGREES,
    longitude: Math.atan2(normalized.y, normalized.x) * RADIANS_TO_DEGREES,
  };
}

function positionInField(
  field: TStreamlineVectorField,
  latitude: number,
  longitude: number
) {
  const normalizedLongitude = field.isGlobal
    ? normalizeLongitude(longitude)
    : longitude;

  if (
    Math.abs(latitude) >= 89.5 ||
    latitude < field.latitudeMin ||
    latitude > field.latitudeMax ||
    (!field.isGlobal &&
      (normalizedLongitude < field.longitudeMin ||
        normalizedLongitude > field.longitudeMax))
  ) {
    return undefined;
  }

  return {
    latitude,
    longitude: normalizedLongitude,
  };
}

function vectorDerivative(
  field: TStreamlineVectorField,
  point: TUnitVector
): TUnitVector | undefined {
  const geographic = unitVectorToGeographic(point);

  const position = positionInField(
    field,
    geographic.latitude,
    geographic.longitude
  );

  if (!position) {
    return undefined;
  }

  const vector = field.sample(position.latitude, position.longitude);

  if (!vector) {
    return undefined;
  }

  const latitude = position.latitude * DEGREES_TO_RADIANS;
  const longitude = position.longitude * DEGREES_TO_RADIANS;

  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);

  const east = {
    x: -sinLongitude,
    y: cosLongitude,
    z: 0,
  };

  const north = {
    x: -sinLatitude * cosLongitude,
    y: -sinLatitude * sinLongitude,
    z: cosLatitude,
  };

  const visualScale = 12 / field.referenceSpeed;
  const derivativeScale = visualScale * DEGREES_TO_RADIANS;

  return {
    x: (vector.u * east.x + vector.v * north.x) * derivativeScale,
    y: (vector.u * east.y + vector.v * north.y) * derivativeScale,
    z: (vector.u * east.z + vector.v * north.z) * derivativeScale,
  };
}

type TVectorDerivative = NonNullable<ReturnType<typeof vectorDerivative>>;

function offsetUnitVector(
  point: TUnitVector,
  derivative: TVectorDerivative,
  seconds: number
) {
  return normalizeUnitVector({
    x: point.x + derivative.x * seconds,
    y: point.y + derivative.y * seconds,
    z: point.z + derivative.z * seconds,
  });
}

function fourthOrderUnitVector(
  point: TUnitVector,
  seconds: number,
  k1: TVectorDerivative,
  k2: TVectorDerivative,
  k3: TVectorDerivative,
  k4: TVectorDerivative
) {
  const scale = seconds / 6;

  return normalizeUnitVector({
    x: point.x + scale * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
    y: point.y + scale * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
    z: point.z + scale * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
  });
}

function thirdOrderUnitVector(
  point: TUnitVector,
  seconds: number,
  k1: TVectorDerivative,
  k2: TVectorDerivative,
  k3: TVectorDerivative
) {
  const scale = seconds / 6;

  return normalizeUnitVector({
    x: point.x + scale * (k1.x + 4 * k2.x + k3.x),
    y: point.y + scale * (k1.y + 4 * k2.y + k3.y),
    z: point.z + scale * (k1.z + 4 * k2.z + k3.z),
  });
}

function fourthOrderDerivatives(
  field: TStreamlineVectorField,
  point: TUnitVector,
  seconds: number
) {
  const k1 = vectorDerivative(field, point);

  if (!k1) {
    return undefined;
  }

  const p2 = offsetUnitVector(point, k1, seconds / 2);
  const k2 = vectorDerivative(field, p2);

  if (!k2) {
    return undefined;
  }

  const p3 = offsetUnitVector(point, k2, seconds / 2);
  const k3 = vectorDerivative(field, p3);

  if (!k3) {
    return undefined;
  }

  const p4 = offsetUnitVector(point, k3, seconds);
  const k4 = vectorDerivative(field, p4);

  if (!k4) {
    return undefined;
  }

  return {
    k1,
    k2,
    k3,
    k4,
  };
}

function angularDistanceDegrees(a: TUnitVector, b: TUnitVector) {
  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);

  return Math.acos(dot) * RADIANS_TO_DEGREES;
}

function integrateRungeKutta43(
  field: TStreamlineVectorField,
  latitude: number,
  longitude: number,
  seconds: number
) {
  const point = geographicToUnitVector(latitude, longitude);

  const derivatives = fourthOrderDerivatives(field, point, seconds);

  if (!derivatives) {
    return undefined;
  }

  const { k1, k2, k3, k4 } = derivatives;

  const thirdStage = normalizeUnitVector({
    x: point.x + seconds * (-k1.x + 2 * k2.x),
    y: point.y + seconds * (-k1.y + 2 * k2.y),
    z: point.z + seconds * (-k1.z + 2 * k2.z),
  });

  const k3Third = vectorDerivative(field, thirdStage);

  if (!k3Third) {
    return undefined;
  }

  const fourth = fourthOrderUnitVector(point, seconds, k1, k2, k3, k4);

  const third = thirdOrderUnitVector(point, seconds, k1, k2, k3Third);

  return {
    fourth,
    error: angularDistanceDegrees(fourth, third),
  };
}

function advanceVectorField(
  field: TStreamlineVectorField,
  latitude: number,
  longitude: number,
  seconds: number,
  subdivisionDepth = 0
) {
  const step = integrateRungeKutta43(field, latitude, longitude, seconds);

  if (!step) {
    return undefined;
  }

  const errorTolerance = Math.max(0.002, Math.abs(seconds) * 0.04);

  if (
    step.error > errorTolerance &&
    subdivisionDepth < 2 &&
    Math.abs(seconds) > 0.004
  ) {
    const firstHalf = advanceVectorField(
      field,
      latitude,
      longitude,
      seconds / 2,
      subdivisionDepth + 1
    );

    if (!firstHalf) {
      return undefined;
    }

    return advanceVectorField(
      field,
      firstHalf.latitude,
      firstHalf.longitude,
      seconds / 2,
      subdivisionDepth + 1
    );
  }

  const geographic = unitVectorToGeographic(step.fourth);

  return positionInField(field, geographic.latitude, geographic.longitude);
}

/**
 * A steady, bilinearly sampled vector field on monotonic latitude/longitude
 * axes. It intentionally has no time state: callers replace the field when a
 * time slider changes, keeping the rendered trajectories as streamlines.
 */
export class RegularVectorField implements TStreamlineVectorField {
  readonly isGlobal: boolean;
  readonly latitudeMin: number;
  readonly latitudeMax: number;
  readonly longitudeMin: number;
  readonly longitudeMax: number;
  readonly referenceSpeed: number;

  private readonly latitudeAscending: boolean;
  private readonly longitudeAscending: boolean;

  constructor(
    readonly latitudes: Float32Array,
    readonly longitudes: Float32Array,
    private readonly uData: Float32Array,
    private readonly vData: Float32Array
  ) {
    const expectedSize = latitudes.length * longitudes.length;

    if (
      latitudes.length < 2 ||
      longitudes.length < 2 ||
      uData.length !== expectedSize ||
      vData.length !== expectedSize
    ) {
      throw new Error("Vector components do not match the regular grid");
    }

    this.latitudeAscending = latitudes[0] <= latitudes.at(-1)!;

    this.longitudeAscending = longitudes[0] <= longitudes.at(-1)!;

    this.latitudeMin = Math.min(latitudes[0], latitudes.at(-1)!);

    this.latitudeMax = Math.max(latitudes[0], latitudes.at(-1)!);

    this.longitudeMin = Math.min(longitudes[0], longitudes.at(-1)!);

    this.longitudeMax = Math.max(longitudes[0], longitudes.at(-1)!);

    this.isGlobal = isGlobalLongitudeAxis(longitudes);

    this.referenceSpeed = calculateReferenceSpeed(uData, vData);
  }

  private orderedAxisValue(
    axis: Float32Array,
    ascending: boolean,
    index: number
  ) {
    return ascending ? axis[index] : axis[axis.length - 1 - index];
  }

  private dataIndex(
    axisLength: number,
    ascending: boolean,
    orderedIndex: number
  ) {
    return ascending ? orderedIndex : axisLength - 1 - orderedIndex;
  }

  private findNonPeriodicBracket(
    axis: Float32Array,
    ascending: boolean,
    value: number
  ): TAxisBracket | undefined {
    const first = this.orderedAxisValue(axis, ascending, 0);

    const last = this.orderedAxisValue(axis, ascending, axis.length - 1);

    if (value < first || value > last) {
      return undefined;
    }

    let low = 0;
    let high = axis.length - 1;

    while (high - low > 1) {
      const middle = (low + high) >> 1;

      if (this.orderedAxisValue(axis, ascending, middle) <= value) {
        low = middle;
      } else {
        high = middle;
      }
    }

    const lowValue = this.orderedAxisValue(axis, ascending, low);

    const highValue = this.orderedAxisValue(axis, ascending, high);

    const fraction =
      highValue === lowValue ? 0 : (value - lowValue) / (highValue - lowValue);

    return {
      lowIndex: this.dataIndex(axis.length, ascending, low),
      highIndex: this.dataIndex(axis.length, ascending, high),
      fraction,
    };
  }

  private findLongitudeBracket(longitude: number) {
    if (!this.isGlobal) {
      return this.findNonPeriodicBracket(
        this.longitudes,
        this.longitudeAscending,
        longitude
      );
    }

    const first = this.orderedAxisValue(
      this.longitudes,
      this.longitudeAscending,
      0
    );

    const last = this.orderedAxisValue(
      this.longitudes,
      this.longitudeAscending,
      this.longitudes.length - 1
    );

    const wrapped = ((((longitude - first) % 360) + 360) % 360) + first;

    if (wrapped <= last) {
      return this.findNonPeriodicBracket(
        this.longitudes,
        this.longitudeAscending,
        wrapped
      );
    }

    return {
      lowIndex: this.dataIndex(
        this.longitudes.length,
        this.longitudeAscending,
        this.longitudes.length - 1
      ),
      highIndex: this.dataIndex(
        this.longitudes.length,
        this.longitudeAscending,
        0
      ),
      fraction: (wrapped - last) / (first + 360 - last),
    };
  }

  sample(latitude: number, longitude: number): TVectorSample | undefined {
    const latitudeBracket = this.findNonPeriodicBracket(
      this.latitudes,
      this.latitudeAscending,
      latitude
    );

    const longitudeBracket = this.findLongitudeBracket(longitude);

    if (!latitudeBracket || !longitudeBracket) {
      return undefined;
    }

    const { lowIndex: y0, highIndex: y1, fraction: fy } = latitudeBracket;

    const { lowIndex: x0, highIndex: x1, fraction: fx } = longitudeBracket;

    const width = this.longitudes.length;

    const interpolate = (data: Float32Array) => {
      const q00 = data[y0 * width + x0];
      const q10 = data[y0 * width + x1];
      const q01 = data[y1 * width + x0];
      const q11 = data[y1 * width + x1];

      if (![q00, q10, q01, q11].every(Number.isFinite)) {
        return NaN;
      }

      const low = q00 + (q10 - q00) * fx;
      const high = q01 + (q11 - q01) * fx;

      return low + (high - low) * fy;
    };

    const u = interpolate(this.uData);
    const v = interpolate(this.vData);

    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return undefined;
    }

    return {
      u,
      v,
      speed: Math.hypot(u, v),
    };
  }

  advance(latitude: number, longitude: number, seconds: number) {
    return advanceVectorField(this, latitude, longitude, seconds);
  }

  randomPosition(random = Math.random) {
    const latitudeMinimum = clamp(this.latitudeMin, -85, 85);

    const latitudeMaximum = clamp(this.latitudeMax, -85, 85);

    const sinLatitudeMinimum = Math.sin(latitudeMinimum * DEGREES_TO_RADIANS);

    const sinLatitudeMaximum = Math.sin(latitudeMaximum * DEGREES_TO_RADIANS);

    const latitude =
      Math.asin(
        sinLatitudeMinimum +
          random() * (sinLatitudeMaximum - sinLatitudeMinimum)
      ) * RADIANS_TO_DEGREES;

    const longitudeSpan = this.isGlobal
      ? 360
      : this.longitudeMax - this.longitudeMin;

    const longitude = this.longitudeMin + random() * longitudeSpan;

    return {
      latitude,
      longitude: this.isGlobal ? normalizeLongitude(longitude) : longitude,
    };
  }
}

/**
 * Inverse-distance interpolation directly over native unstructured
 * geographic cell centres.
 */
export class IrregularVectorField implements TStreamlineVectorField {
  readonly isGlobal: boolean;
  readonly latitudeMin: number;
  readonly latitudeMax: number;
  readonly longitudeMin: number;
  readonly longitudeMax: number;
  readonly referenceSpeed: number;

  private readonly index: KDBush;
  private readonly indexSampleIds: Uint32Array;
  private readonly regularField: RegularVectorField;

  private readonly latitudes: Float32Array;
  private readonly longitudes: Float32Array;
  private readonly uData: Float32Array;
  private readonly vData: Float32Array;

  private readonly interpolationRadiusKm: number;

  // eslint-disable-next-line max-lines-per-function
  constructor(
    latitudes: Float32Array,
    longitudes: Float32Array,
    uData: Float32Array,
    vData: Float32Array
  ) {
    if (
      latitudes.length === 0 ||
      longitudes.length !== latitudes.length ||
      uData.length !== latitudes.length ||
      vData.length !== latitudes.length
    ) {
      throw new Error("Vector components do not match the unstructured grid");
    }

    const samples = filterFiniteVectorSamples(
      latitudes,
      longitudes,
      uData,
      vData
    );

    if (samples.latitudes.length === 0) {
      throw new Error("Vector field has no finite samples");
    }

    this.latitudes = samples.latitudes;

    this.longitudes = Float32Array.from(samples.longitudes, normalizeLongitude);

    this.uData = samples.uData;
    this.vData = samples.vData;

    const latitudeBounds = finiteBounds(this.latitudes);

    const longitudeBounds = finiteBounds(this.longitudes);

    this.latitudeMin = Math.max(-89.5, latitudeBounds.minimum);

    this.latitudeMax = Math.min(89.5, latitudeBounds.maximum);

    this.longitudeMin = longitudeBounds.minimum;
    this.longitudeMax = longitudeBounds.maximum;

    this.isGlobal = this.longitudeMax - this.longitudeMin > 300;

    this.interpolationRadiusKm = interpolationRadiusKm(
      this.latitudes.length,
      this.latitudeMin,
      this.latitudeMax,
      this.longitudeMin,
      this.longitudeMax
    );

    this.referenceSpeed = calculateReferenceSpeed(this.uData, this.vData);

    const indexSize = this.isGlobal
      ? this.latitudes.length * PERIODIC_INDEX_REPLICA_COUNT
      : this.latitudes.length;

    this.index = new KDBush(indexSize);
    this.indexSampleIds = new Uint32Array(indexSize);

    for (let sampleId = 0; sampleId < this.latitudes.length; sampleId++) {
      const latitude = this.latitudes[sampleId];
      const longitude = this.longitudes[sampleId];

      if (this.isGlobal) {
        for (const longitudeOffset of [-360, 0, 360]) {
          const indexId = this.index.add(longitude + longitudeOffset, latitude);

          this.indexSampleIds[indexId] = sampleId;
        }
      } else {
        const indexId = this.index.add(longitude, latitude);

        this.indexSampleIds[indexId] = sampleId;
      }
    }

    this.index.finish();
    this.regularField = this.createRegularField();
  }

  private candidateSampleIds(latitude: number, longitude: number) {
    const maximumIndexResults = this.isGlobal
      ? NATIVE_INTERPOLATION_SAMPLE_COUNT * PERIODIC_INDEX_REPLICA_COUNT
      : NATIVE_INTERPOLATION_SAMPLE_COUNT;

    const indexIds = around(
      this.index,
      longitude,
      clamp(latitude, -90, 90),
      maximumIndexResults,
      Infinity
    );

    const sampleIds = new Set<number>();

    for (const indexId of indexIds) {
      sampleIds.add(this.indexSampleIds[indexId]);
    }

    return [...sampleIds];
  }

  // eslint-disable-next-line max-lines-per-function
  private sampleIndexed(
    latitude: number,
    longitude: number
  ): TVectorSample | undefined {
    const queryLongitude = this.isGlobal
      ? normalizeLongitude(longitude)
      : longitude;

    const candidates = this.candidateSampleIds(latitude, queryLongitude)
      .map((sampleId) => {
        const sampleLongitude = this.isGlobal
          ? nearestEquivalentLongitude(
              this.longitudes[sampleId],
              queryLongitude
            )
          : this.longitudes[sampleId];

        return {
          sampleId,
          separation: distance(
            queryLongitude,
            latitude,
            sampleLongitude,
            this.latitudes[sampleId]
          ),
        };
      })
      .filter(
        ({ separation }) =>
          Number.isFinite(separation) &&
          separation <= this.interpolationRadiusKm
      )
      .sort((a, b) => a.separation - b.separation)
      .slice(0, NATIVE_INTERPOLATION_SAMPLE_COUNT);

    if (candidates.length === 0) {
      return undefined;
    }

    const exact = candidates.find(({ separation }) => separation <= 1e-6);

    if (exact) {
      const u = this.uData[exact.sampleId];
      const v = this.vData[exact.sampleId];

      return {
        u,
        v,
        speed: Math.hypot(u, v),
      };
    }

    let u = 0;
    let v = 0;
    let weightSum = 0;

    for (const { sampleId, separation } of candidates) {
      const weight = 1 / Math.max(separation * separation, 1e-12);

      u += this.uData[sampleId] * weight;
      v += this.vData[sampleId] * weight;
      weightSum += weight;
    }

    if (weightSum <= Number.EPSILON) {
      return undefined;
    }

    u /= weightSum;
    v /= weightSum;

    return {
      u,
      v,
      speed: Math.hypot(u, v),
    };
  }

  private createRegularField() {
    const latitudes = this.isGlobal
      ? Float32Array.from({ length: 179 }, (_, index) => index - 89)
      : regularAxis(this.latitudeMin, this.latitudeMax);

    const longitudes = this.isGlobal
      ? Float32Array.from({ length: 360 }, (_, index) => index - 180)
      : regularAxis(this.longitudeMin, this.longitudeMax);

    const uData = new Float32Array(latitudes.length * longitudes.length);
    const vData = new Float32Array(uData.length);

    for (let y = 0; y < latitudes.length; y++) {
      for (let x = 0; x < longitudes.length; x++) {
        const index = y * longitudes.length + x;
        const vector = this.sampleIndexed(latitudes[y], longitudes[x]);
        uData[index] = vector?.u ?? NaN;
        vData[index] = vector?.v ?? NaN;
      }
    }

    return new RegularVectorField(latitudes, longitudes, uData, vData);
  }

  sample(latitude: number, longitude: number): TVectorSample | undefined {
    return this.regularField.sample(latitude, longitude);
  }

  advance(latitude: number, longitude: number, seconds: number) {
    return advanceVectorField(this, latitude, longitude, seconds);
  }

  randomPosition(random = Math.random) {
    const index = Math.min(
      Math.floor(random() * this.latitudes.length),
      this.latitudes.length - 1
    );

    return {
      latitude: this.latitudes[index],
      longitude: this.longitudes[index],
    };
  }
}
