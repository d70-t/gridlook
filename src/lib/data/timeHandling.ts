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
  let refdate = regExMatch[2];
  if (
    refdate.indexOf(" ") !== refdate.lastIndexOf(" ") &&
    refdate.includes(" ")
  ) {
    // if there are multiple spaces, it's likely because the timezone is included
    // remove the timezone for dayjs parsing
    // The format then is something like "2001-01-01 00:00:00.0 0:00"
    // The stuff after the last space cannot be parsed by dayjs
    const lastSpace = refdate.lastIndexOf(" ");
    refdate = refdate.substring(0, lastSpace);
  }
  const ref = dayjs.utc(refdate);
  // dayjs does not support nanoseconds, so convert to milliseconds
  if (["nanosecond", "nanoseconds", "ns"].includes(interval.toLowerCase())) {
    value = value / 1e6;
    interval = "millisecond";
  }
  const timepoint = ref.add(value, interval as dayjs.ManipulateType);
  return timepoint;
}
