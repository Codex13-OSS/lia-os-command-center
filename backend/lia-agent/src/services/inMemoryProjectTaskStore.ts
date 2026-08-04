import type { CreateProjectTaskResult, ProjectTaskRecord, ProjectTaskStore, SafeTaskError, SafeTaskReceipt } from '../contracts/projectTask.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';

export class InMemoryProjectTaskStore implements ProjectTaskStore {
  private readonly records = new Map<string, ProjectTaskRecord>();
  constructor(private readonly options: { maxRecords: number; maxActive: number; terminalTtlMs: number; now?: () => number } = { maxRecords: 200, maxActive: 8, terminalTtlMs: 86_400_000 }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private prune() {
    const now = this.now();
    for (const [id, record] of this.records) if (record.terminalAt !== undefined && now - record.terminalAt >= this.options.terminalTtlMs) this.records.delete(id);
  }
  createOrGet(taskId: string, fingerprint: string, intent: ProjectTaskRequest): CreateProjectTaskResult {
    this.prune();
    const existing = this.records.get(taskId);
    if (existing) return existing.fingerprint === fingerprint ? { kind: 'known', record: existing } : { kind: 'conflict' };
    const active = [...this.records.values()].filter((item) => item.terminalAt === undefined).length;
    if (this.records.size >= this.options.maxRecords || active >= this.options.maxActive) return { kind: 'capacity' };
    const now = this.now();
    const record: ProjectTaskRecord = { taskId, fingerprint, intent, status: 'accepted', createdAt: now, updatedAt: now };
    this.records.set(taskId, record); return { kind: 'created', record };
  }
  get(taskId: string) { this.prune(); return this.records.get(taskId); }
  transition(taskId: string, status: 'planning' | 'hermes' | 'codex' | 'verification' | 'commit') { const r = this.records.get(taskId); if (r && r.terminalAt === undefined) { r.status = status; r.updatedAt = this.now(); } }
  complete(taskId: string, receipt: SafeTaskReceipt) { const r = this.records.get(taskId); if (r && r.terminalAt === undefined) { r.status = 'completed'; r.receipt = receipt; r.updatedAt = r.terminalAt = this.now(); } }
  fail(taskId: string, error: SafeTaskError) { const r = this.records.get(taskId); if (r && r.terminalAt === undefined) { r.status = 'failed'; r.error = error; r.updatedAt = r.terminalAt = this.now(); } }
}
