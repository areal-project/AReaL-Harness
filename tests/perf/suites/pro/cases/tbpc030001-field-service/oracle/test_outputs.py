import hashlib
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT = Path("/app/schedule_visit.py")


def stamp(value):
    return value.strftime("%Y%m%dT%H%M%SZ")


def calendar(tech, skills, events):
    body = ["BEGIN:VCALENDAR", "VERSION:2.0", f"X-TECHNICIAN:{tech}", f"X-SKILLS:{','.join(skills)}"]
    for index, (start, end) in enumerate(events):
        body += ["BEGIN:VEVENT", f"UID:{tech}-{index}", f"DTSTART:{stamp(start)}", f"DTEND:{stamp(end)}", "SUMMARY:Busy", "END:VEVENT"]
    return "\r\n".join(body + ["END:VCALENDAR", ""])


def parse_output(path):
    raw = path.read_bytes()
    raw.decode("utf-8")
    if b"\n" in raw.replace(b"\r\n", b""):
        raise AssertionError("iCalendar must use CRLF line endings")
    lines = raw.decode("utf-8").splitlines()
    values = {}
    attendees = []
    for line in lines:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key.split(";", 1)[0] == "ATTENDEE":
            attendees.append(value[7:] if value.lower().startswith("mailto:") else value)
        else:
            values[key] = value
    values["ATTENDEE"] = attendees
    return lines, values


class SchedulerTests(unittest.TestCase):
    def run_case(self, request, technicians):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            calendars = root / "calendars"
            calendars.mkdir()
            hashes = {}
            for tech, skills, events in technicians:
                path = calendars / f"{tech}.ics"
                path.write_bytes(calendar(tech, skills, events).encode("utf-8"))
                hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
            request_path = root / "request.json"
            request_path.write_text(json.dumps(request, sort_keys=True), encoding="utf-8")
            request_hash = hashlib.sha256(request_path.read_bytes()).hexdigest()
            output = root / "visit.ics"
            result = subprocess.run(
                ["python3", str(SCRIPT), "--calendars", str(calendars), "--request", str(request_path), "--output", str(output)],
                capture_output=True, text=True, timeout=20,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())
            self.assertEqual(request_hash, hashlib.sha256(request_path.read_bytes()).hexdigest())
            self.assertEqual(hashes, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in calendars.glob("*.ics")})
            return parse_output(output)

    def base_request(self):
        return {
            "title": "Service visit", "attendees": ["a@example.test", "b@example.test"],
            "range_start": "2026-09-07T08:00:00Z", "range_end": "2026-09-09T18:00:00Z",
            "duration_minutes": 60, "work_hours": {"start": "08:00", "end": "18:00"},
            "travel_buffer_minutes": 30, "required_skill": "calibration",
            "preferences": [{"kind": "avoid_weekday", "weekday": 0}, {"kind": "prefer_start_before", "time": "12:00"}],
        }

    def test_ordered_preferences_and_schema(self):
        utc = timezone.utc
        technicians = [
            ("alex", ["calibration"], [(datetime(2026, 9, 8, 8, tzinfo=utc), datetime(2026, 9, 8, 9, 30, tzinfo=utc))]),
            ("blair", ["calibration"], [(datetime(2026, 9, 8, 10, tzinfo=utc), datetime(2026, 9, 8, 11, tzinfo=utc))]),
        ]
        lines, values = self.run_case(self.base_request(), technicians)
        self.assertEqual(lines.count("BEGIN:VEVENT"), 1)
        self.assertEqual(lines.count("END:VEVENT"), 1)
        self.assertEqual((lines[0], lines[-1]), ("BEGIN:VCALENDAR", "END:VCALENDAR"))
        self.assertTrue(values["UID"])
        self.assertEqual(values["SUMMARY"], "Service visit")
        for field in ("UID", "SUMMARY", "DTSTART", "DTEND", "X-TECHNICIAN"):
            self.assertEqual(sum(line.startswith(field + ":") for line in lines), 1)
        self.assertEqual(values["DTSTART"], "20260908T080000Z")
        self.assertEqual(values["DTEND"], "20260908T090000Z")
        self.assertEqual(values["X-TECHNICIAN"], "blair")
        self.assertEqual(values["ATTENDEE"], ["a@example.test", "b@example.test"])

    def test_half_open_boundaries_buffer_and_skill(self):
        request = self.base_request()
        request["range_start"] = "2026-09-08T08:00:00Z"
        request["range_end"] = "2026-09-08T18:00:00Z"
        request["preferences"] = []
        utc = timezone.utc
        technicians = [
            ("no-skill", ["electrical"], []),
            ("zoe", ["calibration"], [(datetime(2026, 9, 8, 8, tzinfo=utc), datetime(2026, 9, 8, 9, tzinfo=utc))]),
        ]
        _, values = self.run_case(request, technicians)
        self.assertEqual(values["DTSTART"], "20260908T093000Z")
        self.assertEqual(values["X-TECHNICIAN"], "zoe")

    def test_no_solution_removes_output(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            calendars = root / "calendars"
            calendars.mkdir()
            (calendars / "x.ics").write_text(calendar("x", ["other"], []), encoding="utf-8")
            request = root / "request.json"
            request.write_text(json.dumps(self.base_request()), encoding="utf-8")
            output = root / "visit.ics"
            output.write_text("stale", encoding="utf-8")
            result = subprocess.run(["python3", str(SCRIPT), "--calendars", str(calendars), "--request", str(request), "--output", str(output)], timeout=20)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_malformed_request_removes_output(self):
        for mutate in (
            lambda request: request.pop("title"),
            lambda request: request.__setitem__("title", ""),
            lambda request: request.__setitem__("required_skill", ""),
            lambda request: request.__setitem__("attendees", "a@example.test"),
            lambda request: request.__setitem__("preferences", [{"kind": "closest_drive"}]),
            lambda request: request.__setitem__("preferences", [{"kind": "avoid_weekday", "weekday": 7}]),
            lambda request: request.__setitem__("range_end", request["range_start"]),
            lambda request: request.__setitem__("duration_minutes", 0),
            lambda request: request.__setitem__("travel_buffer_minutes", -1),
            lambda request: request.__setitem__("work_hours", {"start": "18:00", "end": "08:00"}),
        ):
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as raw:
                root = Path(raw)
                calendars = root / "calendars"
                calendars.mkdir()
                (calendars / "tech.ics").write_text(calendar("tech", ["calibration"], []), encoding="utf-8")
                value = self.base_request()
                value["range_start"] = "2026-09-08T08:00:00Z"
                value["range_end"] = "2026-09-08T18:00:00Z"
                mutate(value)
                request_path = root / "request.json"
                request_path.write_text(json.dumps(value), encoding="utf-8")
                output = root / "visit.ics"
                output.write_text("stale", encoding="utf-8")
                result = subprocess.run(
                    ["python3", str(SCRIPT), "--calendars", str(calendars),
                     "--request", str(request_path), "--output", str(output)],
                    timeout=20,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())

    def test_invalid_calendar_interval_removes_output(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            calendars = root / "calendars"
            calendars.mkdir()
            malformed = calendar("tech", ["calibration"], [])
            malformed = malformed.replace(
                "END:VCALENDAR",
                "BEGIN:VEVENT\r\nUID:bad\r\nDTSTART:20260908T100000Z\r\n"
                "DTEND:20260908T090000Z\r\nSUMMARY:Busy\r\nEND:VEVENT\r\nEND:VCALENDAR",
            )
            (calendars / "tech.ics").write_text(malformed, encoding="utf-8")
            request = root / "request.json"
            request.write_text(json.dumps(self.base_request()), encoding="utf-8")
            output = root / "visit.ics"
            output.write_text("stale", encoding="utf-8")
            result = subprocess.run(
                ["python3", str(SCRIPT), "--calendars", str(calendars),
                 "--request", str(request), "--output", str(output)], timeout=20,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
