import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { TutorState } from "../types.js";
import { projectSnapshot, relevantSkills } from "./projection.js";
import { LearnerMemoryStore } from "./store.js";
function fixture(): TutorState {
 return {schemaVersion:5,conversationId:"c",learningSessionId:"l",sessionStatus:"active",phase:"teach",topic:"MySQL 行锁",lessonTitle:"行锁",diagnosticCards:[],diagnosticAnswers:{},currentCard:0,roadmap:[{id:"lock",title:"行锁等待",target:"解释阻塞",status:"active"}],activeConcept:0,turnCount:1,messages:[],learnerProfile:[],knownIntuitions:[],updatedAt:new Date().toISOString(),nodeLearningStates:{lock:{nodeId:"lock",stage:"practice",evidence:[{criterion:"accurate",learnerQuote:"事务持有同一行锁",strength:"sufficient",questionId:"q",support:"none",verification:"learner-response"}],misconceptions:[],questionsAsked:[],questionHistory:[{id:"q",nodeId:"lock",purpose:"accurate",text:"为什么等待？",thinkingHint:"",support:"none",expectedSignals:[]}]}}};
}
test("legacy and partial evidence cannot grant independence; evidence deduplicates",()=>{
 const s=fixture();const first=projectSnapshot(s).skills[0]!;assert.equal(first.status,"exposed");assert.deepEqual(first.criteria,["accurate"]);
 s.nodeLearningStates.lock!.evidence.push({...s.nodeLearningStates.lock!.evidence[0]!});assert.equal(projectSnapshot(s).skills[0]!.evidence.length,1);
 for(const e of s.nodeLearningStates.lock!.evidence) delete e.verification;
 assert.equal(projectSnapshot(s).skills[0]!.status,"exposed");assert.equal(relevantSkills([first],"烘焙").length,0);assert.equal(relevantSkills([first],"MySQL").length,1);
});
test("PostgreSQL ownership, opt-out and persistent deletion",async(t)=>{
 if(!process.env.POSTGRES_URL)return t.skip("POSTGRES_URL unavailable");
 const schema=`memory_test_${randomUUID().replaceAll("-","")}`;const admin=new Pool({connectionString:process.env.POSTGRES_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:process.env.POSTGRES_URL,options:`-c search_path=${schema}`});
 try{const memory=new LearnerMemoryStore(pool);await memory.ensureSchema();await pool.query("CREATE TABLE cheerful_conversations(user_id text,walry_conversation_id text)");await pool.query("INSERT INTO cheerful_conversations VALUES('u','c')");
 const current=fixture();const save=async()=>{const client=await pool.connect();try{await client.query('BEGIN');await memory.project(client,current);await client.query('COMMIT');}finally{client.release();}};
 await save();await save();assert.equal((await memory.get('u')).skills.length,1);assert.equal((await memory.get('other')).skills.length,0);
 await memory.updatePreferences('u',{enabled:false});assert.equal((await memory.context('u','MySQL')).summary,'');await memory.updatePreferences('u',{enabled:true});
 const before=(await memory.get('u')).skills[0]!.evidence[0]!.observedAt;current.updatedAt='2099-01-01T00:00:00.000Z';await save();assert.equal((await memory.get('u')).skills[0]!.evidence[0]!.observedAt,before);
 await memory.remove('u');await save();assert.equal((await memory.get('u')).skills.length,0);
 current.nodeLearningStates.lock!.evidence[0]!.learnerQuote='这是一次新的独立作答';await save();assert.equal((await memory.get('u')).skills.length,1);
 await memory.updatePreferences('u',{enabled:false});current.nodeLearningStates.lock!.evidence[0]!.learnerQuote='关闭期间作答';await save();await memory.updatePreferences('u',{enabled:true});await save();assert.equal((await memory.get('u')).skills.length,1);assert.equal((await memory.get('u')).skills[0]!.evidence.some(e=>e.quote==='关闭期间作答'),false);
 const id=(await memory.get('u')).skills[0]!.id;await memory.correct('u',id);await save();assert.equal((await memory.get('u')).skills[0]!.needsRecheck,true);await memory.remove('u',id);await save();assert.equal((await memory.get('u')).skills.length,0);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
