export type MemoryEvidence = { id: string; criterion: string; quote: string; question: string; support: string; observedAt: string; conversationId: string; learningSessionId: string };
export type MemorySkill = { id: string; title: string; scope: string; status: "exposed" | "assisted" | "independent"; needsRecheck: boolean; lastVerifiedAt?: string; criteria: string[]; missingCriteria: string[]; misconceptions: string[]; evidence: MemoryEvidence[] };
export type MemoryExperience = { id: string; conversationId: string; learningSessionId: string; title: string; topic: string; updatedAt: string; status: string };
export type LearnerContext = { revision?: string; summary: string; evidenceIds: string[]; skillIds: string[] };
export type MemoryOverview = { revision?: string; enabled: boolean; teachingPreference: string; experiences: MemoryExperience[]; skills: MemorySkill[]; uses: Array<{ query: string; summary: string; createdAt: string }>; updatedAt?: string };
