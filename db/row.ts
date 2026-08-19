/**
 * Typed row reading and parameter binding for node:sqlite.
 *
 * node:sqlite returns rows as `Record<string, SQLOutputValue>`, where a value
 * may be `null | number | bigint | string | Uint8Array`. Casting those straight
 * into domain objects would push every schema mistake (renamed column, wrong
 * type) to whatever code reads the field much later. These helpers assert the
 * expected type at the point of mapping, so a mismatch fails immediately with
 * the column name attached.
 *
 * They also absorb three node:sqlite-specific quirks:
 *
 *   1. SQLite has no boolean type, so flags come back as 0/1 integers.
 *   2. Integers may arrive as `bigint`, notably from COUNT/SUM aggregates.
 *   3. `true`, `false` and `undefined` CANNOT be bound as parameters at all --
 *      node:sqlite throws "Provided value cannot be bound to SQLite parameter".
 *      Everything heading into a statement goes through the bind helpers below.
 */

export type SqlRow = Record<string, unknown>

function fail(column: string, expected: string, value: unknown): never {
  throw new Error(
    `Column "${column}": expected ${expected}, got ${value === null ? 'null' : typeof value}`
  )
}

// --- Reading -----------------------------------------------------------------

export function readString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') fail(column, 'string', value)
  return value
}

export function readStringOrNull(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') fail(column, 'string | null', value)
  return value
}

export function readNumber(row: SqlRow, column: string): number {
  const value = row[column]
  // Aggregates (COUNT, SUM) can come back as bigint depending on magnitude.
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'number') fail(column, 'number', value)
  return value
}

export function readNumberOrNull(row: SqlRow, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  return readNumber(row, column)
}

/** SQLite stores booleans as 0/1 integers. */
export function readBoolean(row: SqlRow, column: string): boolean {
  const value = row[column]
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value !== 'number') fail(column, 'integer boolean (0|1)', value)
  return value !== 0
}

/**
 * Reads a column constrained to a known set of string literals. The DB has
 * CHECK constraints for these, but a value written by an older app version
 * would still slip through, so the set is re-verified on read.
 */
export function readEnum<T extends string>(
  row: SqlRow,
  column: string,
  allowed: readonly T[]
): T {
  const value = readString(row, column)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Column "${column}": ${value} is not one of ${allowed.join(' | ')}`)
  }
  return value as T
}

export function readEnumOrNull<T extends string>(
  row: SqlRow,
  column: string,
  allowed: readonly T[]
): T | null {
  if (row[column] === null || row[column] === undefined) return null
  return readEnum(row, column, allowed)
}

// --- Binding -----------------------------------------------------------------

/** Values node:sqlite will actually accept as a bound parameter. */
export type BindValue = null | number | bigint | string | Uint8Array

/** node:sqlite rejects booleans outright; SQLite stores them as 0/1. */
export function bindBoolean(value: boolean): number {
  return value ? 1 : 0
}

/**
 * node:sqlite rejects `undefined` as well as `null`-ish gaps, and optional
 * domain fields are frequently `undefined` rather than `null`. This collapses
 * both to SQL NULL.
 */
export function bindNullable(value: string | number | null | undefined): BindValue {
  return value === undefined ? null : value
}

/** `changes` and `lastInsertRowid` are typed `number | bigint`. */
export function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}
