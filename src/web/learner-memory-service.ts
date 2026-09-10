import { Pool } from "pg";
import { LearnerMemoryStore } from "../tutor/learner-memory/store.js";

let service: { pool: Pool; memory: LearnerMemoryStore } | undefined;
export function learnerMemoryService() {
  if (!process.env.POSTGRES_URL) throw new Error("学习记忆需要配置 PostgreSQL");
  if (!service) {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    service = { pool, memory: new LearnerMemoryStore(pool) };
  }
  return service;
}
