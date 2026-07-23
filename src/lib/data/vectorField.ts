import { around, distance } from "geokdbush";
import KDBush from "kdbush";

export type TVectorVariablePair = {
  u: string;
  v: string;
  kind: "u/v" | "ua/va" | "uas/vas" | "custom";
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
] as const;

function splitVariableName(name: string) {
  const slashIndex = name.lastIndexOf("/");
  return {
    group: slashIndex === -1 ? "" : name.slice(0, slashIndex),
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
        return { u, v, kind: pair.kind };
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
  if (selection.automatic) {
    return detectVectorVariablePair(variableNames, preferredVariable);
  }
  if (
    selection.u &&
    selection.v &&
    variableNames.includes(selection.u) &&
    variableNames.includes(selection.v)
  ) {
    return { u: selection.u, v: selection.v, kind: "custom" };
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
  return { minimum, maximum };
}

function regularAxis(minimum: number, maximum: number) {
  const count = Math.max(2, Math.ceil(maximum - minimum) + 1);
  return Float32Array.from({ length: count }, (_, index) =>
    count === 1
      ? minimum
      : minimum + (index * (maximum - minimum)) / (count - 1)
  );
}

function interpolationRadiusKm(
  sampleCount: number,
  latitudeMin: number,
  latitudeMax: number,
  longitudeMin: number,
  longitudeMax: number
) {
  const radians = Math.PI / 180;
  const longitudeSpan = Math.min(longitudeMax - longitudeMin, 360) * radians;
  const latitudeFactor = Math.abs(
    Math.sin(latitudeMax * radians) - Math.sin(latitudeMin * radians)
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
    return { latitudes, longitudes, uData, vData };
  }
  return {
    latitudes: Float32Array.from(validIndices, (index) => latitudes[index]),
    longitudes: Float32Array.from(validIndices, (index) => longitudes[index]),
    uData: Float32Array.from(validIndices, (index) => uData[index]),
    vData: Float32Array.from(validIndices, (index) => vData[index]),
  };
}

function vectorRates(
  field: TStreamlineVectorField,
  latitude: number,
  longitude: number
) {
  const vector = field.sample(latitude, longitude);
  if (!vector || vector.speed <= Number.EPSILON) {
    return undefined;
  }
  const cosLatitude = Math.max(Math.cos((latitude * Math.PI) / 180), 0.15);
  const visualScale = 12 / field.referenceSpeed;
  let longitudeRate = (vector.u / cosLatitude) * visualScale;
  let latitudeRate = vector.v * visualScale;
  const angularSpeed = Math.hypot(longitudeRate, latitudeRate);
  if (angularSpeed > 24) {
    const scale = 24 / angularSpeed;
    longitudeRate *= scale;
    latitudeRate *= scale;
  }
  return { latitudeRate, longitudeRate };
}

type TVectorRates = NonNullable<ReturnType<typeof vectorRates>>;

function offsetPosition(
  latitude: number,
  longitude: number,
  rates: TVectorRates,
  seconds: number
) {
  return {
    latitude: latitude + rates.latitudeRate * seconds,
    longitude: longitude + rates.longitudeRate * seconds,
  };
}

function fourthOrderPosition(
  latitude: number,
  longitude: number,
  seconds: number,
  k1: TVectorRates,
  k2: TVectorRates,
  k3: TVectorRates,
  k4: TVectorRates
) {
  return {
    latitude:
      latitude +
      (seconds / 6) *
        (k1.latitudeRate +
          2 * k2.latitudeRate +
          2 * k3.latitudeRate +
          k4.latitudeRate),
    longitude:
      longitude +
      (seconds / 6) *
        (k1.longitudeRate +
          2 * k2.longitudeRate +
          2 * k3.longitudeRate +
          k4.longitudeRate),
  };
}

function thirdOrderPosition(
  latitude: number,
  longitude: number,
  seconds: number,
  k1: TVectorRates,
  k2: TVectorRates,
  k3: TVectorRates
) {
  return {
    latitude:
      latitude +
      (seconds / 6) * (k1.latitudeRate + 4 * k2.latitudeRate + k3.latitudeRate),
    longitude:
      longitude +
      (seconds / 6) *
        (k1.longitudeRate + 4 * k2.longitudeRate + k3.longitudeRate),
  };
}

function fourthOrderRates(
  field: TStreamlineVectorField,
  latitude: number,
  longitude: number,
  seconds: number
) {
  const k1 = vectorRates(field, latitude, longitude);
  if (!k1) {
    return undefined;
  }
  const p2 = offsetPosition(latitude, longitude, k1, seconds / 2);
  const k2 = vectorRates(field, p2.latitude, p2.longitude);
  if (!k2) {
    return undefined;
  }
  const p3 = offsetPosition(latitude, longitude, k2, seconds / 2);
  const k3 = vectorRates(field, p3.latitude, p3.longitude);
  if (!k3) {
    return undefined;
  }
  const p4 = offsetPosition(latitude, longitude, k3, seconds);
  const k4 = vectorRates(field, p4.latitude, p4.longitude);
  if (!k4) {
    return undefined;
  }
  return { k1, k2, k3, k4 };
}

function integrateRungeKutta43(
  field: TStreamlineVectorField,
  latitude: number,
  longitude: number,
  seconds: number
) {
  const rates = fourthOrderRates(field, latitude, longitude, seconds);
  if (!rates) {
    return undefined;
  }
  const { k1, k2, k3, k4 } = rates;

  // Kutta's third-order estimate shares k1 and k2 with classical RK4.
  const thirdStage = {
    latitude: latitude + seconds * (-k1.latitudeRate + 2 * k2.latitudeRate),
    longitude: longitude + seconds * (-k1.longitudeRate + 2 * k2.longitudeRate),
  };
  const k3Third = vectorRates(field, thirdStage.latitude, thirdStage.longitude);
  if (!k3Third) {
    return undefined;
  }

  const fourth = fourthOrderPosition(
    latitude,
    longitude,
    seconds,
    k1,
    k2,
    k3,
    k4
  );
  const third = thirdOrderPosition(
    latitude,
    longitude,
    seconds,
    k1,
    k2,
    k3Third
  );
  return {
    fourth,
    error: Math.hypot(
      fourth.latitude - third.latitude,
      fourth.longitude - third.longitude
    ),
  };
}

function positionInField(
  field: TStreamlineVectorField,
  latitude: number,
  longitude: number
) {
  let normalizedLongitude = longitude;
  if (field.isGlobal) {
    normalizedLongitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
  }
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
  return { latitude, longitude: normalizedLongitude };
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
  return positionInField(field, step.fourth.latitude, step.fourth.longitude);
}

/**
 * A steady, bilinearly sampled vector field on monotonic latitude/longitude
 * axes. It intentionally has no time state: callers replace the field when a
 * time slider changes, keeping the rendered trajectories as streamlines.
 */
export class RegularVectorField {
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

  private orderedAxisValue(axis: Float32Array, ascending: boolean, i: number) {
    return ascending ? axis[i] : axis[axis.length - 1 - i];
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
    return { u, v, speed: Math.hypot(u, v) };
  }

  /** Advance one adaptive RK4/3 integration step through this frozen field. */
  advance(latitude: number, longitude: number, seconds: number) {
    return advanceVectorField(this, latitude, longitude, seconds);
  }

  randomPosition(random = Math.random) {
    const latitude =
      clamp(this.latitudeMin, -85, 85) +
      random() *
        (clamp(this.latitudeMax, -85, 85) - clamp(this.latitudeMin, -85, 85));
    const longitudeSpan = this.isGlobal
      ? 360
      : this.longitudeMax - this.longitudeMin;
    const longitude = this.longitudeMin + random() * longitudeSpan;
    return {
      latitude,
      longitude: this.isGlobal
        ? ((((longitude + 180) % 360) + 360) % 360) - 180
        : longitude,
    };
  }
}

/** Inverse-distance interpolation over unstructured geographic cell centers. */
export class IrregularVectorField implements TStreamlineVectorField {
  readonly isGlobal: boolean;
  readonly latitudeMin: number;
  readonly latitudeMax: number;
  readonly longitudeMin: number;
  readonly longitudeMax: number;
  readonly referenceSpeed: number;

  private readonly index: KDBush;
  private readonly regularField: RegularVectorField | undefined;
  private readonly latitudes: Float32Array;
  private readonly longitudes: Float32Array;
  private readonly uData: Float32Array;
  private readonly vData: Float32Array;
  private readonly interpolationRadiusKm: number;

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
    this.longitudes = samples.longitudes;
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
    this.index = new KDBush(this.latitudes.length);
    for (let i = 0; i < this.latitudes.length; i++) {
      this.index.add(this.longitudes[i], this.latitudes[i]);
    }
    this.index.finish();
    this.regularField = this.createRegularField();
  }

  private sampleIndexed(latitude: number, longitude: number) {
    const ids = around(
      this.index,
      longitude,
      clamp(latitude, -90, 90),
      4,
      Infinity,
      (id) => Number.isFinite(this.uData[id]) && Number.isFinite(this.vData[id])
    );
    if (ids.length === 0) {
      return undefined;
    }
    let u = 0;
    let v = 0;
    let weightSum = 0;
    for (const id of ids) {
      const separation = distance(
        longitude,
        latitude,
        this.longitudes[id],
        this.latitudes[id]
      );
      if (separation > this.interpolationRadiusKm) {
        continue;
      }
      const weight = 1 / Math.max(separation * separation, 1e-6);
      u += this.uData[id] * weight;
      v += this.vData[id] * weight;
      weightSum += weight;
    }
    if (weightSum === 0) {
      return undefined;
    }
    u /= weightSum;
    v /= weightSum;
    return { u, v, speed: Math.hypot(u, v) };
  }

  private createRegularField() {
    // Nullschool's original wind field is a 1° grid with bilinear sampling.
    // Resampling once keeps dense RK4/3 particle animation inexpensive.
    const latitudes = this.isGlobal
      ? Float32Array.from({ length: 179 }, (_, i) => i - 89)
      : regularAxis(this.latitudeMin, this.latitudeMax);
    const longitudes = this.isGlobal
      ? Float32Array.from({ length: 360 }, (_, i) => i - 180)
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
    return this.regularField?.sample(latitude, longitude);
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
