const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A date without zero seconds: "2024-06-06 16:00". */
export const shortDate = (text: string) =>
  text.replace(/(\d\d:\d\d):00$/, "$1");

/** "10-09" as "9 Oct": a month and day no reader takes for 10 September. */
function dayMonth(text: string) {
  const m = /^(\d\d)-(\d\d)(.*)$/.exec(text);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return month ? `${Number(m![2])} ${month}${m![3]}` : text;
}

/**
 * The dates shown, short: without zero seconds, without the year when
 * both share it (the time axis names it), with the month named, and
 * without the day again when both share it: "9 Oct 00:00 – 01:00".
 */
export function compactDateRange(range: string) {
  const [a, b] = range.split(" – ").map(shortDate);
  if (!b) {
    return a ?? "";
  }
  // A time of day both share (monthly means stamped 23:59:59) says nothing.
  const time = (text: string) => / (\d\d:\d\d(:\d\d)?)$/.exec(text)?.[1];
  const same = time(a) !== undefined && time(a) === time(b);
  const [x, y] = same
    ? [a.slice(0, -(time(a)!.length + 1)), b.slice(0, -(time(b)!.length + 1))]
    : [a, b];
  const year = /^(-?\d{4,})-/.exec(x)?.[1];
  if (!year || !y.startsWith(`${year}-`)) {
    return `${x} – ${y}`;
  }
  const [p, q] = [x.slice(year.length + 1), y.slice(year.length + 1)];
  const day = (text: string) => text.slice(0, 5);
  return !same && time(q) && day(p) === day(q)
    ? `${dayMonth(p)} – ${time(q)}`
    : `${dayMonth(p)} – ${dayMonth(q)}`;
}
