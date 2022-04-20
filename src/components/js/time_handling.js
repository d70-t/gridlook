import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

export function decode_time(value, attrs) {
    const units_re = /([a-zA-Z]+) since (.+)$/;
    const [_all, interval, refdate] = attrs.units.match(units_re);
    const ref = dayjs.utc(refdate);
    const timepoint = ref.add(value, interval);
    return timepoint;
}
