'use server'

import { revalidatePath } from 'next/cache'

import { requireSessionUser } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { createServerStorage } from '@/lib/storage/server'

const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

export interface UpdateProfileResult {
  ok: boolean
  error?: string
  avatarUrl?: string | null
}

/**
 * Update the caller's own profile (full name + optional avatar). Scoped to the
 * session user — a caller can only ever update their own row. The optional
 * avatar file is uploaded to MinIO server-side; `removeAvatar` clears it.
 */
export async function updateProfile(
  formData: FormData,
): Promise<UpdateProfileResult> {
  let user
  try {
    user = await requireSessionUser()
  } catch {
    return { ok: false, error: 'Unauthorized' }
  }

  const fullName = String(formData.get('fullName') ?? '').trim()
  if (!fullName) return { ok: false, error: 'Name is required' }

  const removeAvatar = formData.get('removeAvatar') === 'true'
  const file = formData.get('avatar')
  const db = await createClient()

  // Load current avatar so we keep it when nothing changes.
  const { data: current } = await db
    .from('profiles')
    .select('avatar_url')
    .eq('user_id', user.id)
    .maybeSingle()

  let avatarUrl: string | null = (current?.avatar_url as string) ?? null

  if (file && typeof file === 'object' && 'arrayBuffer' in file) {
    const blob = file as File
    if (!ALLOWED_MIME.has(blob.type)) {
      return { ok: false, error: 'Unsupported image type' }
    }
    if (blob.size > MAX_AVATAR_BYTES) {
      return { ok: false, error: 'Image is too large (max 2MB)' }
    }
    const ext = blob.name.split('.').pop()?.toLowerCase() || 'png'
    const path = `${user.id}/avatar-${Date.now()}.${ext}`
    const storage = createServerStorage()
    const { error: uploadError } = await storage
      .from('avatars')
      .upload(path, blob, { contentType: blob.type, upsert: true })
    if (uploadError) {
      return { ok: false, error: `Upload failed: ${uploadError.message}` }
    }
    avatarUrl = storage.from('avatars').getPublicUrl(path).data.publicUrl
  } else if (removeAvatar) {
    avatarUrl = null
  }

  const { error: updateError } = await db
    .from('profiles')
    .update({ full_name: fullName, avatar_url: avatarUrl })
    .eq('user_id', user.id)

  if (updateError) return { ok: false, error: updateError.message }

  revalidatePath('/settings')
  return { ok: true, avatarUrl }
}
