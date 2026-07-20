import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'

// DELETE a tag. Scoped to the caller's account so one account can never delete
// another's tags. Deleting a tag detaches it from every contact (FK cascade).

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await ctx.supabase
    .from('tags')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
