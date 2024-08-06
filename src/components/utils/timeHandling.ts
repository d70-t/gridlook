import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import type { UserAttributes } from "zarr/types/types";
dayjs.extend(utc);

export function decodeTime(value: number, attrs: UserAttributes) {
  const unitsRegEx = /([a-zA-Z]+) since (.+)$/;
  const units: string = attrs.units;
  const regExMatch = units.match(unitsRegEx);
  if (!regExMatch) {
    throw new Error("time units not recognized");
  }
  const [, interval, refdate] = regExMatch;
  const ref = dayjs.utc(refdate);
  const timepoint = ref.add(value, interval);
  return timepoint;
}
