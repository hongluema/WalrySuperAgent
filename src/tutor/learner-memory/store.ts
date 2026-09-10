import type { Pool, PoolClient } from "pg";
import type { TutorState } from "../types.js";
import { memoryId, projectSnapshot, relevantSkills } from "./projection.js";
import type { LearnerContext, MemoryOverview, MemorySkill, MemoryExperience } from "./types.js";
export type { LearnerContext, MemoryOverview } from "./types.js";

export class LearnerMemoryStore {
  private ready?: Promise<void>;
  constructor(private pool: Pool) {}
  async ensureSchema(): Promise<void> {
    this.ready ??= (async () => {
      const client = await this.pool.connect();
      try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext('learner-memory-schema-v1'))"); await client.query(`
      CREATE TABLE IF NOT EXISTS learner_memory_profiles (user_id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, teaching_preference TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS learner_memory_items (user_id TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL, learning_session_id TEXT NOT NULL, kind TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS learner_memory_tombstones (user_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS learner_memory_uses (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, query TEXT NOT NULL, context JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS learner_memory_items_user ON learner_memory_items(user_id,updated_at DESC);
    `); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    })().catch((error) => { this.ready = undefined; throw error; });
    return this.ready;
  }
  private async lock(client: PoolClient, userId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`learner-memory:${userId}`]);
    await client.query("INSERT INTO learner_memory_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
    return (await client.query("SELECT *, xmin::text AS revision FROM learner_memory_profiles WHERE user_id=$1", [userId])).rows[0];
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async lockConversation(client: PoolClient, conversationId: string): Promise<boolean> {
    if (!(await client.query("SELECT to_regclass('cheerful_conversations') AS table_name")).rows[0]?.table_name) return false;
    const owner = (await client.query("SELECT user_id FROM cheerful_conversations WHERE walry_conversation_id::text=$1 LIMIT 1", [conversationId])).rows[0]?.user_id;
    if (!owner) return false;
    await this.lock(client, owner);
    return (await client.query("SELECT 1 FROM cheerful_conversations WHERE walry_conversation_id::text=$1 AND user_id::text=$2", [conversationId, owner])).rowCount !== 0;
  }
  async project(client: PoolClient, state: TutorState): Promise<void> {
    if (!(await client.query("SELECT to_regclass('cheerful_conversations') AS table_name")).rows[0]?.table_name) return;
    const owner = (await client.query("SELECT user_id FROM cheerful_conversations WHERE walry_conversation_id::text=$1 LIMIT 1", [state.conversationId])).rows[0]?.user_id;
    if (!owner) return;
    const profile = await this.lock(client, owner);
    const snapshot = projectSnapshot(state);
    if (!profile.enabled) {
      for (const e of snapshot.skills.flatMap((s) => s.evidence)) await client.query("INSERT INTO learner_memory_tombstones VALUES($1,$2) ON CONFLICT DO NOTHING", [owner, e.id]);
      return;
    }
    const blocked = new Set((await client.query("SELECT id FROM learner_memory_tombstones WHERE user_id=$1", [owner])).rows.map((r) => r.id));
    const filtered = structuredClone(state);
    for (const node of Object.values(filtered.nodeLearningStates ?? {})) node.evidence = node.evidence.filter((e) => !blocked.has(memoryId(state.conversationId, state.learningSessionId, node.nodeId, e.questionId || '', e.learnerQuote, e.criterion)));
    const { experience, skills } = projectSnapshot(filtered);
    const entries: Array<[string, MemoryExperience | MemorySkill]> = [["experience", experience], ...skills.map((s): [string, MemorySkill] => ["skill", s])];
    for (const [kind, item] of entries) {
      if (blocked.has(`cleared:${item.id}`) && (kind === 'skill' ? !(item as MemorySkill).evidence.length : !skills.some((s) => s.evidence.length))) continue;
      if (kind === 'skill') {
        const skill = item as MemorySkill;
        const old = (await client.query("SELECT data FROM learner_memory_items WHERE user_id=$1 AND id=$2", [owner,item.id])).rows[0]?.data as MemorySkill | undefined;
        const oldIds = new Set(old?.evidence.map((e) => e.id));
        const fresh = skill.evidence.some((e) => !oldIds.has(e.id) && e.support === 'none' && skill.criteria.includes(e.criterion));
        for (const e of skill.evidence) e.observedAt = old?.evidence.find((v) => v.id === e.id)?.observedAt || e.observedAt;
        if (!fresh && old?.lastVerifiedAt) skill.lastVerifiedAt = old.lastVerifiedAt;
        if (old?.needsRecheck && !fresh) {
          skill.needsRecheck = true;
          skill.missingCriteria = [...new Set([...skill.missingCriteria, ...skill.criteria])];
          skill.criteria = [];
          if (skill.status === 'independent') skill.status = skill.evidence.some((e) => e.support !== 'none') ? 'assisted' : 'exposed';
        }
      }
      await client.query(`INSERT INTO learner_memory_items(user_id,id,conversation_id,learning_session_id,kind,data)
        SELECT $1,$2,$3,$4,$5,$6::jsonb WHERE NOT EXISTS(SELECT 1 FROM learner_memory_tombstones WHERE user_id=$1 AND id IN ($2,$7))
        ON CONFLICT(user_id,id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
        [owner, item.id, state.conversationId, state.learningSessionId, kind, JSON.stringify(item), `conversation:${state.conversationId}`]);
    }
    await client.query("UPDATE learner_memory_profiles SET updated_at=NOW() WHERE user_id=$1", [owner]);
  }
  async get(userId: string): Promise<MemoryOverview> {
    return this.transaction(async (client) => {
      const p = await this.lock(client, userId);
      const rows = (await client.query("SELECT kind,data FROM learner_memory_items WHERE user_id=$1 ORDER BY updated_at DESC", [userId])).rows;
      const uses = (await client.query("SELECT query, context->>'summary' AS summary, created_at FROM learner_memory_uses WHERE user_id=$1 ORDER BY id DESC LIMIT 20", [userId])).rows;
      return { revision: p.revision, enabled: p.enabled, teachingPreference: p.teaching_preference, experiences: rows.filter((r) => r.kind === "experience").map((r) => r.data), skills: rows.filter((r) => r.kind === "skill").map((r) => r.data), uses: uses.map((u) => ({ query: u.query, summary: u.summary, createdAt: new Date(u.created_at).toISOString() })), updatedAt: new Date(p.updated_at).toISOString() };
    });
  }
  async context(userId: string, query: string, excludeSessionId?: string): Promise<LearnerContext> {
    const memory = await this.get(userId);
    if (!memory.enabled) return { summary: "", evidenceIds: [], skillIds: [] };
    const selected = relevantSkills(memory.skills.filter((s) => !s.evidence.some((e) => e.learningSessionId === excludeSessionId) && !memory.experiences.some((e) => e.learningSessionId === excludeSessionId && s.scope.startsWith(`${e.title}（${e.topic}）：`))), query);
    const summary = [memory.teachingPreference ? `用户明确教学偏好：${memory.teachingPreference.slice(0, 500)}` : "", ...selected.map((s) => `能力：${s.title}；范围：${s.scope}；表现：${s.status}；${s.needsRecheck ? "用户纠正或存在误区，需要重新验证；" : ""}已独立验证维度：${s.criteria.join("、") || "无"}；待验证：${s.missingCriteria.join("、")}；误区：${s.misconceptions.join("；")}；证据：${s.evidence.slice(0, 2).map((e) => `${e.id}「${e.quote.slice(0, 200)}」`).join("；")}`)].filter(Boolean).join("\n").slice(0, 4000);
    const experiences = memory.experiences.filter((e) => e.learningSessionId !== excludeSessionId && relevantSkills([{ id:e.id,title:e.title,scope:e.topic,status:'exposed',needsRecheck:false,criteria:[],missingCriteria:[],misconceptions:[],evidence:[] }],query).length).slice(0,3);
    const experienceText = experiences.map((e) => `接触经历：${e.title}（${e.topic}）；仅表示学过，不表示能力已验证。`).join('\n');
    return { revision: memory.revision, summary: [summary,experienceText].filter(Boolean).join('\n').slice(0,4500), skillIds: selected.map((s) => s.id), evidenceIds: selected.flatMap((s) => s.evidence.slice(0, 2).map((e) => e.id)) };
  }
  async recordUse(userId: string, query: string, context: LearnerContext): Promise<boolean> {
    if (!context.summary) return true;
    return this.transaction(async (client) => {
      const profile = await this.lock(client, userId);
      if (!profile.enabled || (context.revision && context.revision !== profile.revision)) return false;
      const current = (await client.query("SELECT id FROM learner_memory_items WHERE user_id=$1 AND id=ANY($2::text[])", [userId,context.skillIds])).rows;
      if (current.length !== context.skillIds.length) return false;
      await client.query("INSERT INTO learner_memory_uses(user_id,query,context) VALUES($1,$2,$3)", [userId, query.slice(0, 2000), JSON.stringify(context)]);
      await client.query("DELETE FROM learner_memory_uses WHERE user_id=$1 AND id NOT IN (SELECT id FROM learner_memory_uses WHERE user_id=$1 ORDER BY id DESC LIMIT 100)", [userId]);
      return true;
    });
  }
  async updatePreferences(userId: string, values: { enabled?: boolean; teachingPreference?: string }): Promise<void> {
    await this.transaction(async (client) => {
      await this.lock(client, userId);
      await client.query("UPDATE learner_memory_profiles SET enabled=COALESCE($2,enabled), teaching_preference=COALESCE($3,teaching_preference),updated_at=NOW() WHERE user_id=$1", [userId, values.enabled ?? null, values.teachingPreference?.slice(0, 2000) ?? null]);
    });
  }
  async remove(userId: string, itemId?: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.lock(client, userId);
      await client.query("UPDATE learner_memory_profiles SET updated_at=NOW() WHERE user_id=$1", [userId]);
      // Deleting an experience also deletes its course-local capabilities.
      const target = itemId ? (await client.query("SELECT kind,learning_session_id,conversation_id FROM learner_memory_items WHERE user_id=$1 AND id=$2", [userId, itemId])).rows[0] : undefined;
      const ids = (await client.query("SELECT id FROM learner_memory_items WHERE user_id=$1 AND ($2::text IS NULL OR id=$2 OR ($3::text IS NOT NULL AND learning_session_id=$3 AND conversation_id=$4))", [userId, itemId ?? null, target?.kind === "experience" ? target.learning_session_id : null, target?.conversation_id ?? null])).rows.map((r) => r.id);
      if (itemId) ids.push(itemId);
      if (!itemId) {
        const previous = (await client.query("SELECT data FROM learner_memory_items WHERE user_id=$1 AND kind='skill'", [userId])).rows;
        for (const e of previous.flatMap((r) => (r.data as MemorySkill).evidence)) await client.query("INSERT INTO learner_memory_tombstones VALUES($1,$2) ON CONFLICT DO NOTHING", [userId,e.id]);
      }
      for (const id of new Set(ids)) await client.query("INSERT INTO learner_memory_tombstones VALUES($1,$2) ON CONFLICT DO NOTHING", [userId, itemId ? id : `cleared:${id}`]);
      await client.query("DELETE FROM learner_memory_items WHERE user_id=$1 AND id=ANY($2::text[])", [userId, ids]);
      await client.query("DELETE FROM learner_memory_uses WHERE user_id=$1", [userId]);
      if (!itemId) await client.query("UPDATE learner_memory_profiles SET teaching_preference='',updated_at=NOW() WHERE user_id=$1", [userId]);
    });
  }
  async correct(userId: string, itemId: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.lock(client, userId);
      await client.query("UPDATE learner_memory_profiles SET updated_at=NOW() WHERE user_id=$1", [userId]);
      await client.query("DELETE FROM learner_memory_uses WHERE user_id=$1", [userId]);
      await client.query(`UPDATE learner_memory_items SET data=data || jsonb_build_object('needsRecheck',true,'status',CASE WHEN data->>'status'='independent' THEN 'exposed' ELSE data->>'status' END,'missingCriteria',COALESCE(data->'missingCriteria','[]'::jsonb) || COALESCE(data->'criteria','[]'::jsonb),'criteria','[]'::jsonb),updated_at=NOW() WHERE user_id=$1 AND id=$2 AND kind='skill'`, [userId, itemId]);
    });
  }
  async backfill(userId: string): Promise<void> {
    await this.transaction(async (client) => {
      if (!(await client.query("SELECT to_regclass('cheerful_conversations') AS c, to_regclass('tutor_learning_sessions') AS t")).rows.some((r) => r.c && r.t)) return;
      if (!(await this.lock(client, userId)).enabled) return;
      const rows = (await client.query("SELECT s.state_json FROM tutor_learning_sessions s JOIN cheerful_conversations c ON c.walry_conversation_id::text=s.conversation_id WHERE c.user_id=$1 ORDER BY s.updated_at", [userId])).rows;
      for (const row of rows) await this.project(client, row.state_json as TutorState);
    });
  }
  async forgetConversation(client: PoolClient, conversationId: string): Promise<void> {
    const owners = (await client.query("SELECT DISTINCT user_id FROM learner_memory_items WHERE conversation_id=$1", [conversationId])).rows;
    for (const { user_id: userId } of owners) {
      await this.lock(client, userId);
      await client.query("INSERT INTO learner_memory_tombstones VALUES($1,$2) ON CONFLICT DO NOTHING", [userId, `conversation:${conversationId}`]);
      await client.query("DELETE FROM learner_memory_items WHERE user_id=$1 AND conversation_id=$2", [userId, conversationId]);
      await client.query("DELETE FROM learner_memory_uses WHERE user_id=$1", [userId]);
    }
  }
}
