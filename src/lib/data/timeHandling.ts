import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import * as zarr from "zarrita";

dayjs.extend(utc);

export function decodeTime(value: number, attrs: zarr.Attributes) {
  const unitsRegEx = /([a-zA-Z]+) since (.+)$/;
  const units: string = attrs.units as string;
  const regExMatch = units.match(unitsRegEx);
  if (!regExMatch) {
    throw new Error("time units not recognized");
  }
  const [, interval, refdate] = regExMatch;
  const ref = dayjs.utc(refdate);
  const timepoint = ref.add(value, interval as dayjs.ManipulateType);
  return timepoint;
}
