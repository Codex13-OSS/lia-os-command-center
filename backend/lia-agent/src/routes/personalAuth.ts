import { Router, type Request, type Response } from 'express';
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.LIA_PERSONAL_ACCOUNTS_DB
  || '/opt/lia-os-data/personal-accounts.sqlite';

const COOKIE = 'lia_personal_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  created_at: number;
};

type ProfileRow = {
  payload_json: string;
};

function db(): DatabaseSync {
  return new DatabaseSync(DB_PATH);
}

function emailValid(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function passwordValid(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 128;
}

function sameOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true;

  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function derive(password: string, saltHex: string): Buffer {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function accountPayload(database: DatabaseSync, user: UserRow) {
  const profile = database.prepare(`
    SELECT payload_json
    FROM lia_personal_profiles
    WHERE user_id = ?
  `).get(user.id) as ProfileRow | undefined;

  if (!profile) throw new Error('profile_missing');

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      createdAt: new Date(user.created_at).toISOString(),
    },
    profile: JSON.parse(profile.payload_json),
  };
}

function setSession(res: Response, database: DatabaseSync, userId: string): void {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;

  database.prepare(`
    DELETE FROM lia_personal_sessions WHERE expires_at <= ?
  `).run(now);

  database.prepare(`
    INSERT INTO lia_personal_sessions
      (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashToken(token), userId, now, expires);

  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

function authenticatedUser(database: DatabaseSync, req: Request): UserRow | undefined {
  const token = parseCookies(req)[COOKIE];
  if (!token) return undefined;

  return database.prepare(`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.password_salt,
      u.password_hash,
      u.created_at
    FROM lia_personal_sessions s
    JOIN lia_personal_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
  `).get(hashToken(token), Date.now()) as UserRow | undefined;
}

export function createPersonalAuthRouter(): Router {
  const router = Router();

  router.use('/api/lia-agent/personal-auth', (req, res, next) => {
    if (!sameOrigin(req)) {
      res.status(403).json({ ok: false, error: 'origin_rejected' });
      return;
    }
    next();
  });

  router.get('/api/lia-agent/personal-auth/session', (req, res) => {
    const database = db();
    try {
      const user = authenticatedUser(database, req);
      if (!user) {
        res.json({ authenticated: false });
        return;
      }

      res.json({
        authenticated: true,
        ...accountPayload(database, user),
      });
    } finally {
      database.close();
    }
  });

  router.post('/api/lia-agent/personal-auth/login', (req, res) => {
    const { email, password } = req.body ?? {};

    if (!emailValid(email)) {
      res.status(400).json({ ok: false, error: 'invalid_email' });
      return;
    }
    if (!passwordValid(password)) {
      res.status(400).json({ ok: false, error: 'invalid_password' });
      return;
    }

    const database = db();

    try {
      const user = database.prepare(`
        SELECT
          id,
          email,
          display_name,
          password_salt,
          password_hash,
          created_at
        FROM lia_personal_users
        WHERE lower(email) = lower(?)
      `).get(email.trim()) as UserRow | undefined;

      if (!user) {
        res.status(401).json({ ok: false, error: 'invalid_credentials' });
        return;
      }

      let stored: Buffer;
      try {
        stored = Buffer.from(user.password_hash, 'hex');
      } catch {
        res.status(401).json({ ok: false, error: 'invalid_credentials' });
        return;
      }

      const candidate = derive(password, user.password_salt);

      if (
        stored.length !== candidate.length
        || !timingSafeEqual(stored, candidate)
      ) {
        res.status(401).json({ ok: false, error: 'invalid_credentials' });
        return;
      }

      setSession(res, database, user.id);
      res.json({ ok: true, ...accountPayload(database, user) });
    } finally {
      database.close();
    }
  });

  router.post('/api/lia-agent/personal-auth/register', (req, res) => {
    const { email, password, displayName, profile } = req.body ?? {};

    if (!emailValid(email)) {
      res.status(400).json({ ok: false, error: 'invalid_email' });
      return;
    }
    if (!passwordValid(password)) {
      res.status(400).json({ ok: false, error: 'invalid_password' });
      return;
    }
    if (typeof displayName !== 'string' || !displayName.trim()) {
      res.status(400).json({ ok: false, error: 'invalid_display_name' });
      return;
    }
    if (!profile || typeof profile !== 'object') {
      res.status(400).json({ ok: false, error: 'invalid_profile' });
      return;
    }

    const database = db();

    try {
      const normalizedEmail = email.trim().toLowerCase();
      const existing = database.prepare(`
        SELECT id FROM lia_personal_users WHERE lower(email) = lower(?)
      `).get(normalizedEmail);

      if (existing) {
        res.status(409).json({ ok: false, error: 'email_already_registered' });
        return;
      }

      const id = randomUUID();
      const now = Date.now();
      const salt = randomBytes(32).toString('hex');
      const hash = derive(password, salt).toString('hex');

      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`
          INSERT INTO lia_personal_users
            (id, email, display_name, password_salt, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, normalizedEmail, displayName.trim(), salt, hash, now, now);

        database.prepare(`
          INSERT INTO lia_personal_profiles
            (user_id, payload_json, onboarding_completed, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(
          id,
          JSON.stringify(profile),
          (profile as { onboardingCompleted?: unknown }).onboardingCompleted === true ? 1 : 0,
          now,
        );

        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }

      const user = database.prepare(`
        SELECT
          id,
          email,
          display_name,
          password_salt,
          password_hash,
          created_at
        FROM lia_personal_users WHERE id = ?
      `).get(id) as UserRow;

      setSession(res, database, id);
      res.status(201).json({ ok: true, ...accountPayload(database, user) });
    } finally {
      database.close();
    }
  });

  router.put('/api/lia-agent/personal-auth/profile', (req, res) => {
    const profile = req.body?.profile;
    if (!profile || typeof profile !== 'object') {
      res.status(400).json({ ok: false, error: 'invalid_profile' });
      return;
    }

    const database = db();

    try {
      const user = authenticatedUser(database, req);
      if (!user) {
        res.status(401).json({ ok: false, error: 'unauthenticated' });
        return;
      }

      const now = Date.now();
      database.prepare(`
        UPDATE lia_personal_profiles
        SET payload_json = ?,
            onboarding_completed = ?,
            updated_at = ?
        WHERE user_id = ?
      `).run(
        JSON.stringify(profile),
        (profile as { onboardingCompleted?: unknown }).onboardingCompleted === true ? 1 : 0,
        now,
        user.id,
      );

      res.json({ ok: true, ...accountPayload(database, user) });
    } finally {
      database.close();
    }
  });

  router.post('/api/lia-agent/personal-auth/logout', (req, res) => {
    const database = db();

    try {
      const token = parseCookies(req)[COOKIE];
      if (token) {
        database.prepare(`
          DELETE FROM lia_personal_sessions WHERE token_hash = ?
        `).run(hashToken(token));
      }

      res.clearCookie(COOKIE, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
      });

      res.json({ ok: true });
    } finally {
      database.close();
    }
  });

  return router;
}
