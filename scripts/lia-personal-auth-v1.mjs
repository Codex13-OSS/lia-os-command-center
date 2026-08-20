import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PREFIX = '/api/lia-agent/personal-auth/';
const COOKIE_NAME = 'lia_personal_session_v1';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROFILE_BYTES = 48 * 1024;

function failure(code) {
  const error = new Error(code);
  error.liaCode = code;
  return error;
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    email.length < 5 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) throw failure('invalid_email');
  return email;
}

function normalizePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw failure('invalid_password');
  }
  return value;
}

function normalizeDisplayName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 80) throw failure('invalid_display_name');
  return name;
}

function normalizeProfile(value, forcedDisplayName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('invalid_profile');
  }

  const profile = JSON.parse(JSON.stringify(value));
  if (profile.version !== 1 || profile.onboardingCompleted !== true) {
    throw failure('invalid_profile');
  }

  const displayName = normalizeDisplayName(
    forcedDisplayName ?? profile.identity?.displayName,
  );

  profile.identity = {
    ...(profile.identity && typeof profile.identity === 'object' ? profile.identity : {}),
    displayName,
  };

  const json = JSON.stringify(profile);
  if (Buffer.byteLength(json, 'utf8') > MAX_PROFILE_BYTES) {
    throw failure('profile_too_large');
  }

  return { profile, json, displayName };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function derivePassword(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString('hex');
}

function passwordMatches(password, saltHex, expectedHex) {
  try {
    const actual = Buffer.from(derivePassword(password, saltHex), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function publicAccount(row, profile) {
  return {
    user: {
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.displayName),
      createdAt: new Date(Number(row.createdAt)).toISOString(),
    },
    profile,
  };
}

export function createLiaPersonalAccountStore(databasePath, clock = () => Date.now()) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
    throw failure('invalid_account_database_path');
  }

  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS lia_personal_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lia_personal_profiles (
      user_id TEXT PRIMARY KEY
        REFERENCES lia_personal_users(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL,
      onboarding_completed INTEGER NOT NULL CHECK(onboarding_completed IN (0, 1)),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lia_personal_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
        REFERENCES lia_personal_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS lia_personal_sessions_user
      ON lia_personal_sessions(user_id);
    CREATE INDEX IF NOT EXISTS lia_personal_sessions_expiry
      ON lia_personal_sessions(expires_at);
  `);

  const userByEmail = database.prepare(`
    SELECT
      u.id,
      u.email,
      u.display_name AS displayName,
      u.password_salt AS passwordSalt,
      u.password_hash AS passwordHash,
      u.created_at AS createdAt,
      p.payload_json AS profileJson
    FROM lia_personal_users u
    JOIN lia_personal_profiles p ON p.user_id = u.id
    WHERE u.email = ?
  `);

  const sessionByHash = database.prepare(`
    SELECT
      u.id,
      u.email,
      u.display_name AS displayName,
      u.created_at AS createdAt,
      p.payload_json AS profileJson
    FROM lia_personal_sessions s
    JOIN lia_personal_users u ON u.id = s.user_id
    JOIN lia_personal_profiles p ON p.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `);

  const insertUser = database.prepare(`
    INSERT INTO lia_personal_users (
      id, email, display_name, password_salt, password_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertProfile = database.prepare(`
    INSERT INTO lia_personal_profiles (
      user_id, payload_json, onboarding_completed, updated_at
    ) VALUES (?, ?, 1, ?)
  `);

  const insertSession = database.prepare(`
    INSERT INTO lia_personal_sessions (
      token_hash, user_id, created_at, expires_at
    ) VALUES (?, ?, ?, ?)
  `);

  const deleteExpired = database.prepare(
    'DELETE FROM lia_personal_sessions WHERE expires_at <= ?',
  );
  const deleteSession = database.prepare(
    'DELETE FROM lia_personal_sessions WHERE token_hash = ?',
  );
  const updateUser = database.prepare(`
    UPDATE lia_personal_users
    SET display_name = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateProfile = database.prepare(`
    UPDATE lia_personal_profiles
    SET payload_json = ?, onboarding_completed = 1, updated_at = ?
    WHERE user_id = ?
  `);

  function issueSession(userId) {
    const createdAt = clock();
    const expiresAt = createdAt + SESSION_TTL_MS;
    const token = randomBytes(32).toString('base64url');
    deleteExpired.run(createdAt);
    insertSession.run(sha256(token), userId, createdAt, expiresAt);
    return { token, expiresAt };
  }

  function readSession(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const now = clock();
    deleteExpired.run(now);
    const row = sessionByHash.get(sha256(token), now);
    if (!row) return null;

    try {
      return publicAccount(row, JSON.parse(String(row.profileJson)));
    } catch {
      throw failure('corrupt_profile_record');
    }
  }

  return {
    register(input) {
      const email = normalizeEmail(input?.email);
      const password = normalizePassword(input?.password);
      const displayName = normalizeDisplayName(input?.displayName);
      const normalized = normalizeProfile(input?.profile, displayName);

      if (userByEmail.get(email)) throw failure('email_already_registered');

      const id = randomUUID();
      const now = clock();
      const salt = randomBytes(16).toString('hex');
      const passwordHash = derivePassword(password, salt);

      database.exec('BEGIN IMMEDIATE');
      try {
        insertUser.run(id, email, displayName, salt, passwordHash, now, now);
        insertProfile.run(id, normalized.json, now);
        const session = issueSession(id);
        database.exec('COMMIT');

        return {
          ...publicAccount(
            { id, email, displayName, createdAt: now },
            normalized.profile,
          ),
          ...session,
        };
      } catch (error) {
        database.exec('ROLLBACK');
        if (String(error?.message || '').includes('UNIQUE')) {
          throw failure('email_already_registered');
        }
        throw error;
      }
    },

    login(input) {
      const email = normalizeEmail(input?.email);
      const password = normalizePassword(input?.password);
      const row = userByEmail.get(email);

      if (!row) {
        derivePassword(password, '00112233445566778899aabbccddeeff');
        throw failure('invalid_credentials');
      }

      if (!passwordMatches(password, String(row.passwordSalt), String(row.passwordHash))) {
        throw failure('invalid_credentials');
      }

      let profile;
      try {
        profile = JSON.parse(String(row.profileJson));
      } catch {
        throw failure('corrupt_profile_record');
      }

      return {
        ...publicAccount(row, profile),
        ...issueSession(String(row.id)),
      };
    },

    readSession,

    saveProfile(token, value) {
      const current = readSession(token);
      if (!current) throw failure('unauthenticated');

      const normalized = normalizeProfile(value);
      const now = clock();

      database.exec('BEGIN IMMEDIATE');
      try {
        updateUser.run(normalized.displayName, now, current.user.id);
        updateProfile.run(normalized.json, now, current.user.id);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }

      return {
        user: {
          ...current.user,
          displayName: normalized.displayName,
        },
        profile: normalized.profile,
      };
    },

    logout(token) {
      if (typeof token === 'string' && token.length >= 20 && token.length <= 200) {
        deleteSession.run(sha256(token));
      }
    },

    close() {
      database.close();
    },
  };
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function cookieValue(request) {
  const raw = typeof request.headers.cookie === 'string' ? request.headers.cookie : '';
  for (const item of raw.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function sessionCookie(token, secure) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function clearSessionCookie(secure) {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') {
    const remote = request.socket.remoteAddress || '';
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  }

  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw failure('payload_too_large');
    chunks.push(chunk);
  }

  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw failure('invalid_json');
  }
}

export function createLiaPersonalAuthHandler({
  enabled = false,
  databasePath = '',
  secureCookies = false,
} = {}) {
  const store =
    enabled && typeof databasePath === 'string' && path.isAbsolute(databasePath)
      ? createLiaPersonalAccountStore(databasePath)
      : null;

  const attempts = new Map();

  function rateAllowed(request, action) {
    const now = Date.now();
    const key = `${request.socket.remoteAddress || 'unknown'}:${action}`;
    const previous = attempts.get(key);

    if (!previous || previous.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
      return true;
    }

    previous.count += 1;
    return previous.count <= 20;
  }

  async function handler(request, response, requestUrl) {
    if (!requestUrl.pathname.startsWith(PREFIX)) return false;

    if (!store) {
      jsonResponse(response, 503, {
        ok: false,
        error: 'personal_accounts_disabled',
      });
      return true;
    }

    if (requestUrl.search) {
      jsonResponse(response, 400, { ok: false, error: 'invalid_query' });
      return true;
    }

    const action = requestUrl.pathname.slice(PREFIX.length);
    const token = cookieValue(request);

    try {
      if (action === 'session' && request.method === 'GET') {
        const session = store.readSession(token);
        jsonResponse(response, 200, session
          ? { ok: true, authenticated: true, ...session }
          : { ok: true, authenticated: false });
        return true;
      }

      if (!sameOrigin(request)) throw failure('origin_rejected');

      if (action === 'logout' && request.method === 'POST') {
        store.logout(token);
        response.setHeader('Set-Cookie', clearSessionCookie(secureCookies));
        jsonResponse(response, 200, { ok: true, authenticated: false });
        return true;
      }

      if (
        (action === 'register' || action === 'login') &&
        request.method === 'POST'
      ) {
        if (!rateAllowed(request, action)) throw failure('rate_limited');
        const body = await readJsonBody(request);
        const result = action === 'register'
          ? store.register(body)
          : store.login(body);

        response.setHeader('Set-Cookie', sessionCookie(result.token, secureCookies));
        jsonResponse(response, action === 'register' ? 201 : 200, {
          ok: true,
          authenticated: true,
          user: result.user,
          profile: result.profile,
          safety: {
            profileScopedByUserId: true,
            createsAgents: false,
            grantsCapabilities: false,
          },
        });
        return true;
      }

      if (action === 'profile' && request.method === 'PUT') {
        const body = await readJsonBody(request);
        const result = store.saveProfile(token, body.profile);
        jsonResponse(response, 200, {
          ok: true,
          authenticated: true,
          ...result,
          safety: {
            profileScopedByUserId: true,
            createsAgents: false,
            grantsCapabilities: false,
          },
        });
        return true;
      }

      jsonResponse(response, 405, {
        ok: false,
        error: 'method_not_allowed',
      });
    } catch (error) {
      const code = error?.liaCode || 'internal_error';
      const statuses = {
        invalid_email: 400,
        invalid_password: 400,
        invalid_display_name: 400,
        invalid_profile: 400,
        profile_too_large: 413,
        payload_too_large: 413,
        invalid_json: 400,
        email_already_registered: 409,
        invalid_credentials: 401,
        unauthenticated: 401,
        origin_rejected: 403,
        rate_limited: 429,
        corrupt_profile_record: 500,
      };

      jsonResponse(response, statuses[code] || 500, {
        ok: false,
        error: code,
      });
    }

    return true;
  }

  handler.enabled = store !== null;
  handler.close = () => store?.close();
  return handler;
}
