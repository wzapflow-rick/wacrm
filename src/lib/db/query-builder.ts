/**
 * PostgREST-compatible query builder over node-postgres.
 *
 * Reimplements the subset of the Supabase client API that the CRM uses so the
 * ~329 existing `.from(...).select(...)` call sites keep working against your
 * own Postgres (VPS) with minimal changes. Supported surface:
 *
 *   from(table)
 *   select(cols, { count, head })   — incl. nested embeds: contact:contacts(*)
 *   insert(values) / update(values) / upsert(values, { onConflict }) / delete()
 *   eq neq gt gte lt lte in is like ilike or match filter
 *   order(col, { ascending, nullsFirst }) / limit(n) / range(from, to)
 *   single() / maybeSingle()
 *   rpc(fn, args)
 *
 * Every terminal is awaited and resolves to `{ data, error, count }` — matching
 * the Supabase result shape, so callers that check `error` keep working.
 *
 * NOTE: account/user isolation (previously enforced by RLS) is layered on top
 * of this in later phases via scoped clients — this file is the raw engine.
 */
import { pool } from './pool'
import { resolveRelationship } from './relationships'

export interface PostgrestError {
  message: string
  code?: string
  details?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PostgrestResult<T = any> {
  data: T | null
  error: PostgrestError | null
  count?: number | null
}

// ------------------------------------------------------------------
// select-string parsing
// ------------------------------------------------------------------

interface ColumnNode {
  kind: 'column'
  name: string
  alias?: string
}

interface EmbedNode {
  kind: 'embed'
  target: string
  alias: string
  hint?: string
  inner: boolean
  cols: SelectNode[]
}

type SelectNode = ColumnNode | EmbedNode

/** Split a string on a delimiter, ignoring delimiters inside parentheses. */
function splitTopLevel(input: string, delim = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === delim && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

function parseSelect(cols: string): SelectNode[] {
  const trimmed = cols.trim()
  if (!trimmed || trimmed === '*') return [{ kind: 'column', name: '*' }]

  return splitTopLevel(trimmed).map((part): SelectNode => {
    const parenIndex = part.indexOf('(')
    if (parenIndex !== -1) {
      // embed: [alias:]target[!hint][!inner](subcols)
      const head = part.slice(0, parenIndex).trim()
      const body = part.slice(parenIndex + 1, part.lastIndexOf(')'))

      let alias: string | undefined
      let spec = head
      const colonIndex = head.indexOf(':')
      if (colonIndex !== -1) {
        alias = head.slice(0, colonIndex).trim()
        spec = head.slice(colonIndex + 1).trim()
      }

      const segments = spec.split('!').map((s) => s.trim())
      const target = segments[0]
      let hint: string | undefined
      let inner = false
      for (const seg of segments.slice(1)) {
        if (seg === 'inner') inner = true
        else if (seg === 'left') inner = false
        else hint = seg
      }

      return {
        kind: 'embed',
        target,
        alias: alias ?? target,
        hint,
        inner,
        cols: parseSelect(body),
      }
    }

    // plain column, optionally aliased: alias:name
    const colonIndex = part.indexOf(':')
    if (colonIndex !== -1) {
      return {
        kind: 'column',
        alias: part.slice(0, colonIndex).trim(),
        name: part.slice(colonIndex + 1).trim(),
      }
    }
    return { kind: 'column', name: part }
  })
}

// ------------------------------------------------------------------
// param collector
// ------------------------------------------------------------------

class Params {
  values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

function quoteId(id: string): string {
  if (id === '*') return '*'
  return `"${id.replace(/"/g, '""')}"`
}

// ------------------------------------------------------------------
// SELECT expression builder (handles nested embeds via JSON subqueries)
// ------------------------------------------------------------------

function buildSelectExpressions(
  baseTable: string,
  baseAlias: string,
  nodes: SelectNode[],
  params: Params,
  depth: number,
  innerConditions: string[]
): string[] {
  const exprs: string[] = []

  for (const node of nodes) {
    if (node.kind === 'column') {
      if (node.name === '*') {
        exprs.push(`${quoteId(baseAlias)}.*`)
      } else if (node.alias) {
        exprs.push(
          `${quoteId(baseAlias)}.${quoteId(node.name)} AS ${quoteId(node.alias)}`
        )
      } else {
        exprs.push(`${quoteId(baseAlias)}.${quoteId(node.name)}`)
      }
      continue
    }

    // embed
    const rel = resolveRelationship(baseTable, node.target, node.hint)
    const childAlias = `_e${depth}`
    const childInner: string[] = []
    const childExprs = buildSelectExpressions(
      node.target,
      childAlias,
      node.cols,
      params,
      depth + 1,
      childInner
    )

    const joinCondition = `${quoteId(childAlias)}.${quoteId(rel.target)} = ${quoteId(baseAlias)}.${quoteId(rel.local)}`
    const extraWhere =
      childInner.length > 0 ? ` AND ${childInner.join(' AND ')}` : ''

    if (rel.type === 'many') {
      exprs.push(
        `(SELECT COALESCE(json_agg(_row), '[]'::json) FROM (` +
          `SELECT ${childExprs.join(', ')} FROM ${quoteId(node.target)} ${quoteId(childAlias)} ` +
          `WHERE ${joinCondition}${extraWhere}) _row) AS ${quoteId(node.alias)}`
      )
    } else {
      exprs.push(
        `(SELECT to_jsonb(_row) FROM (` +
          `SELECT ${childExprs.join(', ')} FROM ${quoteId(node.target)} ${quoteId(childAlias)} ` +
          `WHERE ${joinCondition}${extraWhere} LIMIT 1) _row) AS ${quoteId(node.alias)}`
      )
    }

    if (node.inner) {
      innerConditions.push(
        `EXISTS (SELECT 1 FROM ${quoteId(node.target)} ${quoteId(childAlias)} ` +
          `WHERE ${joinCondition}${extraWhere})`
      )
    }
  }

  return exprs
}

// ------------------------------------------------------------------
// filters
// ------------------------------------------------------------------

type Filter =
  | { kind: 'cmp'; column: string; op: string; value: unknown }
  | { kind: 'in'; column: string; values: unknown[] }
  | { kind: 'is'; column: string; value: null | boolean }
  | { kind: 'or'; raw: string }

const OP_SQL: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
}

function parseInList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\(/, '').replace(/\)$/, '')
    return trimmed.length ? trimmed.split(',').map((v) => v.trim()) : []
  }
  return [value]
}

function buildFilterSql(
  filter: Filter,
  alias: string,
  params: Params
): string {
  switch (filter.kind) {
    case 'cmp': {
      const sqlOp = OP_SQL[filter.op] ?? '='
      return `${quoteId(alias)}.${quoteId(filter.column)} ${sqlOp} ${params.add(filter.value)}`
    }
    case 'in': {
      if (filter.values.length === 0) return 'FALSE'
      const placeholders = filter.values.map((v) => params.add(v)).join(', ')
      return `${quoteId(alias)}.${quoteId(filter.column)} IN (${placeholders})`
    }
    case 'is': {
      if (filter.value === null)
        return `${quoteId(alias)}.${quoteId(filter.column)} IS NULL`
      return `${quoteId(alias)}.${quoteId(filter.column)} IS ${filter.value ? 'TRUE' : 'FALSE'}`
    }
    case 'or': {
      // "col.op.value,col2.op2.value2" → (cond OR cond2)
      const conditions = splitTopLevel(filter.raw).map((clause) => {
        const [column, op, ...rest] = clause.split('.')
        const rawValue = rest.join('.')
        if (op === 'is') {
          if (rawValue === 'null')
            return `${quoteId(alias)}.${quoteId(column)} IS NULL`
          return `${quoteId(alias)}.${quoteId(column)} IS ${rawValue === 'true' ? 'TRUE' : 'FALSE'}`
        }
        if (op === 'in') {
          const values = parseInList(rawValue)
          if (values.length === 0) return 'FALSE'
          const placeholders = values.map((v) => params.add(v)).join(', ')
          return `${quoteId(alias)}.${quoteId(column)} IN (${placeholders})`
        }
        const sqlOp = OP_SQL[op] ?? '='
        // ilike/like values may contain wildcards already
        return `${quoteId(alias)}.${quoteId(column)} ${sqlOp} ${params.add(rawValue)}`
      })
      return `(${conditions.join(' OR ')})`
    }
  }
}

// ------------------------------------------------------------------
// the builder
// ------------------------------------------------------------------

type Operation = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

interface OrderSpec {
  column: string
  ascending: boolean
  nullsFirst?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class PgQueryBuilder<T = any>
  implements PromiseLike<PostgrestResult<T>>
{
  private op: Operation = 'select'
  private selectCols = '*'
  private returning = false
  private filters: Filter[] = []
  private orders: OrderSpec[] = []
  private limitN?: number
  private offsetN?: number
  private rangeCount?: number
  private wantSingle = false
  private wantMaybeSingle = false
  private mutationValues: Record<string, unknown>[] = []
  private conflictTarget?: string
  private countMode?: string
  private headOnly = false

  constructor(private table: string) {}

  // --- terminal selectors -----------------------------------------
  select(
    cols = '*',
    options?: { count?: string; head?: boolean }
  ): this {
    this.selectCols = cols
    this.returning = true
    if (options?.count) this.countMode = options.count
    if (options?.head) this.headOnly = true
    return this
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = 'insert'
    this.mutationValues = Array.isArray(values) ? values : [values]
    return this
  }

  update(values: Record<string, unknown>): this {
    this.op = 'update'
    this.mutationValues = [values]
    return this
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string }
  ): this {
    this.op = 'upsert'
    this.mutationValues = Array.isArray(values) ? values : [values]
    this.conflictTarget = options?.onConflict
    return this
  }

  delete(): this {
    this.op = 'delete'
    return this
  }

  // --- filters -----------------------------------------------------
  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'eq', value })
    return this
  }
  neq(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'neq', value })
    return this
  }
  gt(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'gt', value })
    return this
  }
  gte(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'gte', value })
    return this
  }
  lt(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'lt', value })
    return this
  }
  lte(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'lte', value })
    return this
  }
  like(column: string, value: string): this {
    this.filters.push({ kind: 'cmp', column, op: 'like', value })
    return this
  }
  ilike(column: string, value: string): this {
    this.filters.push({ kind: 'cmp', column, op: 'ilike', value })
    return this
  }
  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: 'in', column, values })
    return this
  }
  is(column: string, value: null | boolean): this {
    this.filters.push({ kind: 'is', column, value })
    return this
  }
  or(raw: string): this {
    this.filters.push({ kind: 'or', raw })
    return this
  }
  match(query: Record<string, unknown>): this {
    for (const [column, value] of Object.entries(query)) {
      this.filters.push({ kind: 'cmp', column, op: 'eq', value })
    }
    return this
  }
  filter(column: string, operator: string, value: unknown): this {
    if (operator === 'in') {
      this.filters.push({ kind: 'in', column, values: parseInList(value) })
    } else if (operator === 'is') {
      const v = value === 'null' || value === null ? null : Boolean(value)
      this.filters.push({ kind: 'is', column, value: v })
    } else {
      this.filters.push({ kind: 'cmp', column, op: operator, value })
    }
    return this
  }

  // --- modifiers ---------------------------------------------------
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean }
  ): this {
    this.orders.push({
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst,
    })
    return this
  }
  limit(count: number): this {
    this.limitN = count
    return this
  }
  range(from: number, to: number): this {
    this.offsetN = from
    this.rangeCount = to - from + 1
    return this
  }
  single(): this {
    this.wantSingle = true
    return this
  }
  maybeSingle(): this {
    this.wantMaybeSingle = true
    return this
  }

  // --- execution ---------------------------------------------------
  private buildWhere(params: Params, alias: string, innerConditions: string[]): string {
    const conditions = this.filters.map((f) => buildFilterSql(f, alias, params))
    conditions.push(...innerConditions)
    return conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  }

  private buildOrderLimit(): string {
    let sql = ''
    if (this.orders.length) {
      const parts = this.orders.map((o) => {
        let s = `${quoteId(o.column)} ${o.ascending ? 'ASC' : 'DESC'}`
        if (o.nullsFirst !== undefined)
          s += o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'
        return s
      })
      sql += ` ORDER BY ${parts.join(', ')}`
    }
    const limit = this.rangeCount ?? this.limitN
    if (limit !== undefined) sql += ` LIMIT ${Number(limit)}`
    if (this.offsetN !== undefined) sql += ` OFFSET ${Number(this.offsetN)}`
    return sql
  }

  private returningClause(params: Params): string {
    if (!this.returning) return ''
    const nodes = parseSelect(this.selectCols)
    const innerConditions: string[] = []
    const exprs = buildSelectExpressions(
      this.table,
      this.table,
      nodes,
      params,
      0,
      innerConditions
    )
    return ` RETURNING ${exprs.join(', ')}`
  }

  private async run(): Promise<PostgrestResult<T>> {
    const params = new Params()
    let sql = ''

    if (this.op === 'select') {
      const nodes = parseSelect(this.selectCols)
      const innerConditions: string[] = []
      const exprs = buildSelectExpressions(
        this.table,
        this.table,
        nodes,
        params,
        0,
        innerConditions
      )

      if (this.countMode && this.headOnly) {
        const where = this.buildWhere(params, this.table, innerConditions)
        const countSql = `SELECT count(*)::int AS count FROM ${quoteId(this.table)} ${quoteId(this.table)}${where}`
        const res = await pool.query(countSql, params.values as never[])
        return { data: [] as unknown as T, error: null, count: res.rows[0]?.count ?? 0 }
      }

      sql = `SELECT ${exprs.join(', ')} FROM ${quoteId(this.table)} ${quoteId(this.table)}`
      sql += this.buildWhere(params, this.table, innerConditions)
      sql += this.buildOrderLimit()
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const columns = Array.from(
        new Set(this.mutationValues.flatMap((row) => Object.keys(row)))
      )
      if (columns.length === 0) {
        return {
          data: null,
          error: { message: 'insert called with no columns' },
        }
      }
      const rowsSql = this.mutationValues
        .map(
          (row) =>
            `(${columns.map((c) => (c in row ? params.add(row[c]) : 'DEFAULT')).join(', ')})`
        )
        .join(', ')
      sql = `INSERT INTO ${quoteId(this.table)} (${columns.map(quoteId).join(', ')}) VALUES ${rowsSql}`

      if (this.op === 'upsert') {
        const conflict = this.conflictTarget
          ? this.conflictTarget
              .split(',')
              .map((c) => quoteId(c.trim()))
              .join(', ')
          : undefined
        if (conflict) {
          const updates = columns
            .filter((c) => !this.conflictTarget!.split(',').map((x) => x.trim()).includes(c))
            .map((c) => `${quoteId(c)} = EXCLUDED.${quoteId(c)}`)
          sql += ` ON CONFLICT (${conflict}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`
        } else {
          sql += ' ON CONFLICT DO NOTHING'
        }
      }
      sql += this.returningClause(params)
    } else if (this.op === 'update') {
      const row = this.mutationValues[0] ?? {}
      const sets = Object.keys(row).map(
        (c) => `${quoteId(c)} = ${params.add(row[c])}`
      )
      if (sets.length === 0) {
        return { data: null, error: { message: 'update called with no columns' } }
      }
      sql = `UPDATE ${quoteId(this.table)} ${quoteId(this.table)} SET ${sets.join(', ')}`
      sql += this.buildWhere(params, this.table, [])
      sql += this.returningClause(params)
    } else {
      // delete
      sql = `DELETE FROM ${quoteId(this.table)} ${quoteId(this.table)}`
      sql += this.buildWhere(params, this.table, [])
      sql += this.returningClause(params)
    }

    const result = await pool.query(sql, params.values as never[])
    let rows = result.rows as unknown[]

    // single / maybeSingle handling
    if (this.wantSingle || this.wantMaybeSingle) {
      if (rows.length === 0) {
        if (this.wantMaybeSingle) return { data: null, error: null }
        return {
          data: null,
          error: {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        }
      }
      if (rows.length > 1) {
        return {
          data: null,
          error: {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        }
      }
      return { data: rows[0] as T, error: null }
    }

    // mutations without a select return null data (Supabase convention)
    if (this.op !== 'select' && !this.returning) {
      return { data: null, error: null }
    }

    return { data: rows as unknown as T, error: null, count: rows.length }
  }

  private async execute(): Promise<PostgrestResult<T>> {
    try {
      return await this.run()
    } catch (err) {
      const e = err as { message?: string; code?: string; detail?: string }
      console.log('[v0] query-builder error:', e.message, e.code)
      return {
        data: null,
        error: {
          message: e.message ?? 'Database error',
          code: e.code,
          details: e.detail,
        },
      }
    }
  }

  then<TResult1 = PostgrestResult<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: PostgrestResult<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}

// ------------------------------------------------------------------
// rpc builder
// ------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class PgRpcBuilder<T = any>
  implements PromiseLike<PostgrestResult<T>>
{
  private filters: Filter[] = []
  private orders: OrderSpec[] = []
  private limitN?: number
  private wantSingle = false
  private wantMaybeSingle = false

  constructor(
    private fn: string,
    private args: Record<string, unknown> = {}
  ) {}

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'eq', value })
    return this
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending ?? true })
    return this
  }
  limit(count: number): this {
    this.limitN = count
    return this
  }
  single(): this {
    this.wantSingle = true
    return this
  }
  maybeSingle(): this {
    this.wantMaybeSingle = true
    return this
  }

  private async run(): Promise<PostgrestResult<T>> {
    const params = new Params()
    const argKeys = Object.keys(this.args)
    const argSql = argKeys
      .map((k) => `${k} := ${params.add(this.args[k])}`)
      .join(', ')

    let sql = `SELECT * FROM ${quoteId(this.fn)}(${argSql}) _rpc`

    if (this.filters.length) {
      const where = this.filters
        .map((f) => buildFilterSql(f, '_rpc', params))
        .join(' AND ')
      sql += ` WHERE ${where}`
    }
    if (this.orders.length) {
      sql += ` ORDER BY ${this.orders
        .map((o) => `${quoteId(o.column)} ${o.ascending ? 'ASC' : 'DESC'}`)
        .join(', ')}`
    }
    if (this.limitN !== undefined) sql += ` LIMIT ${Number(this.limitN)}`

    const result = await pool.query(sql, params.values as never[])
    const rows = result.rows as unknown[]

    if (this.wantSingle || this.wantMaybeSingle) {
      if (rows.length === 0)
        return this.wantMaybeSingle
          ? { data: null, error: null }
          : {
              data: null,
              error: { code: 'PGRST116', message: 'no rows returned' },
            }
      return { data: rows[0] as T, error: null }
    }

    return { data: rows as unknown as T, error: null }
  }

  private async execute(): Promise<PostgrestResult<T>> {
    try {
      return await this.run()
    } catch (err) {
      const e = err as { message?: string; code?: string; detail?: string }
      console.log('[v0] rpc error:', this.fn, e.message, e.code)
      return {
        data: null,
        error: {
          message: e.message ?? 'Database error',
          code: e.code,
          details: e.detail,
        },
      }
    }
  }

  then<TResult1 = PostgrestResult<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: PostgrestResult<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}
