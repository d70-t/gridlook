import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import * as zarr from "zarrita";

dayjs.extend(utc);

export function decodeTime(value: number, attrs: zarr.Attributes) {
  const unitsRegEx = /([a-zA-Z]+) since (.+)$/i;
  const units: string = attrs.units as string;
  const regExMatch = units.match(unitsRegEx);
  if (!regExMatch) {
    throw new Error("time units not recognized");
  }
  let interval = regExMatch[1];
  const refdate = regExMatch[2];

  const ref = dayjs.utc(refdate);
  // dayjs does not support nanoseconds, so convert to milliseconds
  if (["nanosecond", "nanoseconds", "ns"].includes(interval.toLowerCase())) {
    value = value / 1e6;
    interval = "millisecond";
  }
  const timepoint = ref.add(value, interval as dayjs.ManipulateType);
  return timepoint;
}
