import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

// Tags — colour-coded contact labels, shared across the account.
// GET lists the account's tags; POST creates one. Account isolation is
// enforced here (no RLS) by scoping every query with ctx.accountId.

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('tags')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ tags: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const color = typeof body.color === 'string' ? body.color.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    return NextResponse.json({ error: 'color must be a hex value' }, { status: 400 })
  }

  const { data, error } = await ctx.supabase
    .from('tags')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      name,
      color,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tag: data }, { status: 201 })
}
