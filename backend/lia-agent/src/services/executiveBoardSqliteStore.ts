import { chmodSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ExecutiveBoardDecision,
  ExecutiveBoardDecisionStore,
  ExecutiveBoardOutcome,
  ExecutiveBoardOutcomeTransition,
} from '../contracts/executiveBoard.js';

const MAX_LIST_LIMIT = 50;

export class ExecutiveBoardSqliteStore implements ExecutiveBoardDecisionStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    if (!isAbsolute(databasePath) || databasePath.includes('\0')) throw new Error('invalid_executive_board_sqlite_path');
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS executive_board_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 2)
      ) STRICT;
      INSERT OR IGNORE INTO executive_board_meta (singleton, schema_version) VALUES (1, 2);
      CREATE TABLE IF NOT EXISTS executive_board_decisions (
        decision_id TEXT PRIMARY KEY CHECK (length(decision_id) BETWEEN 1 AND 100),
        request_key TEXT NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 1 AND 200),
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 200),
        goal_id TEXT CHECK (goal_id IS NULL OR length(goal_id) BETWEEN 1 AND 100),
        decision_json TEXT NOT NULL CHECK (json_valid(decision_json) AND json_type(decision_json, '$') = 'object'),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS executive_board_decisions_project_created
      ON executive_board_decisions(project_id, created_at DESC, decision_id ASC);
      CREATE TABLE IF NOT EXISTS executive_board_outcome_transitions (
        transition_id INTEGER PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES executive_board_decisions(decision_id),
        request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
        status TEXT NOT NULL CHECK (status IN ('approved', 'rejected', 'executed', 'superseded')),
        summary TEXT CHECK (summary IS NULL OR length(summary) <= 20000),
        evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json, '$') = 'array'),
        recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
        UNIQUE(decision_id, request_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS executive_board_outcomes_decision_order
      ON executive_board_outcome_transitions(decision_id, transition_id ASC);
      CREATE TRIGGER IF NOT EXISTS executive_board_decisions_immutable_update
      BEFORE UPDATE ON executive_board_decisions BEGIN
        SELECT RAISE(ABORT, 'executive_board_decision_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS executive_board_decisions_immutable_delete
      BEFORE DELETE ON executive_board_decisions BEGIN
        SELECT RAISE(ABORT, 'executive_board_decision_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS executive_board_outcomes_immutable_update
      BEFORE UPDATE ON executive_board_outcome_transitions BEGIN
        SELECT RAISE(ABORT, 'executive_board_outcome_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS executive_board_outcomes_immutable_delete
      BEFORE DELETE ON executive_board_outcome_transitions BEGIN
        SELECT RAISE(ABORT, 'executive_board_outcome_immutable');
      END;
    `);
    chmodSync(databasePath, 0o600);
  }

  recordDecision(input: {
    requestKey: string;
    requestHash: string;
    decision: ExecutiveBoardDecision;
  }): ExecutiveBoardDecision {
    if (input.requestKey !== input.decision.requestKey) {
      throw new Error('executive_board_request_key_conflict');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT OR IGNORE INTO executive_board_decisions (
          decision_id, request_key, request_hash, project_id, goal_id, decision_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.decision.decisionId,
        input.requestKey,
        input.requestHash,
        input.decision.projectId,
        input.decision.goalId ?? null,
        JSON.stringify(input.decision),
        input.decision.createdAt,
        input.decision.updatedAt,
      );
      const row = this.#database.prepare(`
        SELECT decision_id, request_hash FROM executive_board_decisions WHERE request_key = ?
      `).get(input.requestKey) as { decision_id: string; request_hash: string } | undefined;
      if (!row) throw new Error('executive_board_decision_id_conflict');
      if (row.request_hash !== input.requestHash) throw new Error('executive_board_request_key_conflict');
      const decision = this.readDecision(row.decision_id);
      if (!decision) throw new Error('executive_board_decision_not_found');
      this.#database.exec('COMMIT');
      return decision;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  readDecision(decisionId: string): ExecutiveBoardDecision | undefined {
    const row = this.#database.prepare(
      'SELECT decision_json FROM executive_board_decisions WHERE decision_id = ?',
    ).get(decisionId) as { decision_json: string } | undefined;
    return row ? this.#withEffectiveOutcome(JSON.parse(row.decision_json) as ExecutiveBoardDecision) : undefined;
  }

  listDecisions(input: { projectId: string; goalId?: string; limit?: number }): ExecutiveBoardDecision[] {
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(input.limit ?? 20)));
    const rows = input.goalId === undefined
      ? this.#database.prepare(`
          SELECT decision_json FROM executive_board_decisions
          WHERE project_id = ? ORDER BY created_at DESC, decision_id ASC LIMIT ?
        `).all(input.projectId, limit)
      : this.#database.prepare(`
          SELECT decision_json FROM executive_board_decisions
          WHERE project_id = ? AND goal_id = ?
          ORDER BY created_at DESC, decision_id ASC LIMIT ?
        `).all(input.projectId, input.goalId, limit);
    return rows.map((row) => this.#withEffectiveOutcome(
      JSON.parse((row as { decision_json: string }).decision_json) as ExecutiveBoardDecision,
    ));
  }

  transitionOutcome(transition: ExecutiveBoardOutcomeTransition): ExecutiveBoardDecision {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const snapshotRow = this.#database.prepare(
        'SELECT decision_json FROM executive_board_decisions WHERE decision_id = ?',
      ).get(transition.decisionId) as { decision_json: string } | undefined;
      if (!snapshotRow) throw new Error('executive_board_decision_not_found');

      const existing = this.#database.prepare(`
        SELECT status, summary, evidence_json FROM executive_board_outcome_transitions
        WHERE decision_id = ? AND request_key = ?
      `).get(transition.decisionId, transition.requestKey) as {
        status: string;
        summary: string | null;
        evidence_json: string;
      } | undefined;
      const evidenceJson = JSON.stringify(transition.evidence);
      if (existing) {
        if (existing.status !== transition.status
          || existing.summary !== (transition.summary ?? null)
          || existing.evidence_json !== evidenceJson) {
          throw new Error('executive_board_outcome_request_key_conflict');
        }
        const decision = this.#withEffectiveOutcome(
          JSON.parse(snapshotRow.decision_json) as ExecutiveBoardDecision,
        );
        this.#database.exec('COMMIT');
        return decision;
      }

      const snapshot = JSON.parse(snapshotRow.decision_json) as ExecutiveBoardDecision;
      const current = this.#effectiveOutcome(snapshot.decisionId, snapshot.outcome);
      if (current.status !== transition.status && !this.#isLegalTransition(current.status, transition.status)) {
        throw new Error('illegal_executive_board_outcome_transition');
      }
      if (current.status !== transition.status) {
        this.#database.prepare(`
          INSERT INTO executive_board_outcome_transitions (
            decision_id, request_key, status, summary, evidence_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          transition.decisionId,
          transition.requestKey,
          transition.status,
          transition.summary ?? null,
          evidenceJson,
          transition.recordedAt,
        );
      }
      const decision = this.#withEffectiveOutcome(snapshot);
      this.#database.exec('COMMIT');
      return decision;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #isLegalTransition(from: ExecutiveBoardOutcome['status'], to: ExecutiveBoardOutcome['status']): boolean {
    return (from === 'pending' && ['approved', 'rejected', 'superseded'].includes(to))
      || (from === 'approved' && ['executed', 'superseded'].includes(to));
  }

  #effectiveOutcome(decisionId: string, initial: ExecutiveBoardOutcome): ExecutiveBoardOutcome {
    const row = this.#database.prepare(`
      SELECT status, summary, evidence_json, recorded_at
      FROM executive_board_outcome_transitions
      WHERE decision_id = ? ORDER BY transition_id DESC LIMIT 1
    `).get(decisionId) as {
      status: ExecutiveBoardOutcome['status'];
      summary: string | null;
      evidence_json: string;
      recorded_at: number;
    } | undefined;
    if (!row) return structuredClone(initial);
    return {
      status: row.status,
      ...(row.summary === null ? {} : { summary: row.summary }),
      recordedAt: row.recorded_at,
      evidence: JSON.parse(row.evidence_json) as ExecutiveBoardOutcome['evidence'],
    };
  }

  #withEffectiveOutcome(snapshot: ExecutiveBoardDecision): ExecutiveBoardDecision {
    return { ...snapshot, outcome: this.#effectiveOutcome(snapshot.decisionId, snapshot.outcome) };
  }

  close(): void {
    this.#database.close();
  }
}
