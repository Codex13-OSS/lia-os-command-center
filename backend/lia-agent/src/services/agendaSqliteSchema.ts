export const AGENDA_SQLITE_SCHEMA_VERSION = 1;

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function hasValidDateTimeComponents(isoDateTime: string): boolean {
  const match = ISO_DATE_TIME_PATTERN.exec(isoDateTime);

  if (match === null) {
    return false;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

export function createAgendaSqliteSchemaV1Sql(initializedAt: string): string {
  if (
    !hasValidDateTimeComponents(initializedAt) ||
    !Number.isFinite(Date.parse(initializedAt))
  ) {
    throw new Error('invalid_agenda_initialized_at');
  }

  const initializedAtSql = initializedAt.replaceAll("'", "''");

  return `
CREATE TABLE agenda_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  global_revision INTEGER NOT NULL DEFAULT 0 CHECK (global_revision >= 0),
  timezone TEXT NOT NULL DEFAULT 'America/Mexico_City' CHECK (timezone <> ''),
  updated_at TEXT NOT NULL CHECK (updated_at <> '')
) STRICT;

INSERT INTO agenda_state (
  singleton,
  schema_version,
  global_revision,
  timezone,
  updated_at
) VALUES (
  1,
  ${AGENDA_SQLITE_SCHEMA_VERSION},
  0,
  'America/Mexico_City',
  '${initializedAtSql}'
);

CREATE TABLE agenda_events (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  start_time TEXT NOT NULL,
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json))
    CHECK (json_type(payload_json, '$') IS 'object')
    CHECK (json_type(payload_json, '$.id') IS 'text')
    CHECK (json_extract(payload_json, '$.id') = id)
    CHECK (json_type(payload_json, '$.startTime') IS 'text')
    CHECK (json_extract(payload_json, '$.startTime') = start_time)
    CHECK (json_type(payload_json, '$.source') IS 'text')
    CHECK (json_extract(payload_json, '$.source') IN ('local', 'migrated_v1', 'external'))
) STRICT;

CREATE INDEX agenda_events_start_time_id
ON agenda_events(start_time, id);
`;
}
