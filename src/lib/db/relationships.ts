/**
 * Relationship registry used by the query-builder shim to resolve
 * PostgREST-style embedded resources, e.g.:
 *
 *   .select('*, contact:contacts(*), stage:pipeline_stages(name)')
 *
 * Each entry describes how a BASE table joins to a TARGET table.
 *   - local:  column on the base table
 *   - target: column on the target table (usually its primary key)
 *   - type:   'one'  → embed resolves to a single object (base references target)
 *             'many' → embed resolves to an array (target references base)
 *
 * Foreign-key hints in the select string (e.g. `profiles!deals_assigned_to_fkey`)
 * are parsed automatically and take precedence over this registry.
 */

export type RelationshipType = 'one' | 'many'

export interface Relationship {
  local: string
  target: string
  type: RelationshipType
}

const REGISTRY: Record<string, Relationship> = {
  // deals
  'deals.contacts': { local: 'contact_id', target: 'id', type: 'one' },
  'deals.pipeline_stages': { local: 'stage_id', target: 'id', type: 'one' },
  'deals.pipelines': { local: 'pipeline_id', target: 'id', type: 'one' },
  'deals.profiles': { local: 'assigned_to', target: 'id', type: 'one' },
  'deals.conversations': { local: 'conversation_id', target: 'id', type: 'one' },

  // contact_tags
  'contact_tags.tags': { local: 'tag_id', target: 'id', type: 'one' },
  'contact_tags.contacts': { local: 'contact_id', target: 'id', type: 'one' },

  // messages
  'messages.conversations': { local: 'conversation_id', target: 'id', type: 'one' },

  // conversations
  'conversations.contacts': { local: 'contact_id', target: 'id', type: 'one' },
  'conversations.profiles': { local: 'assigned_agent_id', target: 'id', type: 'one' },

  // broadcast_recipients
  'broadcast_recipients.broadcasts': {
    local: 'broadcast_id',
    target: 'id',
    type: 'one',
  },
  'broadcast_recipients.contacts': {
    local: 'contact_id',
    target: 'id',
    type: 'one',
  },

  // automation
  'automation_logs.automations': {
    local: 'automation_id',
    target: 'id',
    type: 'one',
  },
  'automation_logs.contacts': { local: 'contact_id', target: 'id', type: 'one' },
  'automation_steps.automations': {
    local: 'automation_id',
    target: 'id',
    type: 'one',
  },

  // flows
  'flow_logs.flows': { local: 'flow_id', target: 'id', type: 'one' },
  'flow_logs.contacts': { local: 'contact_id', target: 'id', type: 'one' },

  // pipeline stages
  'pipeline_stages.pipelines': { local: 'pipeline_id', target: 'id', type: 'one' },

  // contact sub-resources
  'contact_custom_values.custom_fields': {
    local: 'custom_field_id',
    target: 'id',
    type: 'one',
  },
  'contact_notes.contacts': { local: 'contact_id', target: 'id', type: 'one' },
}

/**
 * Resolve a relationship between a base table and a target table.
 *
 * @param baseTable  the table currently being queried
 * @param target     the embedded target table name
 * @param hint       optional FK hint from the select string (e.g. "deals_assigned_to_fkey")
 */
export function resolveRelationship(
  baseTable: string,
  target: string,
  hint?: string
): Relationship {
  // FK hint form: "<base>_<column>_fkey" → localColumn = <column>
  if (hint) {
    const stripped = hint
      .replace(new RegExp(`^${baseTable}_`), '')
      .replace(/_fkey$/, '')
    if (stripped) {
      return { local: stripped, target: 'id', type: 'one' }
    }
  }

  const key = `${baseTable}.${target}`
  if (REGISTRY[key]) return REGISTRY[key]

  // Fallback convention: assume base references target via `<singular target>_id`.
  const singular = target.endsWith('s') ? target.slice(0, -1) : target
  return { local: `${singular}_id`, target: 'id', type: 'one' }
}
