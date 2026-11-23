import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { AuthStatusResponse } from '../shared/types.ts';
import { stateStore } from './stateStore.ts';

interface StoredAdminAuth {
  saltHex: string;
  hashHex: string;
  claimedAt: string;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SIGNING_SECRET = process.env.SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('hex');

function getAuthFilePath(): string {
  const resolved = path.resolve(stateStore.stateDir, 'admin_auth.json');
  if (!resolved.startsWith(stateStore.stateDir + path.sep)) {
    throw new Error('Ruta de credenciales no valida.');
  }
  return resolved;
}

function readStoredAdminAuth(): StoredAdminAuth | null {
  const target = getAuthFilePath();
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as StoredAdminAuth;
    if (parsed && typeof parsed.saltHex === 'string' && typeof parsed.hashHex === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function hashPasswordScrypt(password: string, saltHex: string): string {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export function isEnvPasscodeConfigured(): boolean {
  return Boolean(process.env.ADMIN_DASHBOARD_PASSCODE && process.env.ADMIN_DASHBOARD_PASSCODE.trim().length > 0);
}

export function requiresInitialClaim(): boolean {
  if (isEnvPasscodeConfigured()) return false;
  return readStoredAdminAuth() === null;
}

export function claimInitialAdminPassword(password: string): { ok: boolean; error?: string } {
  if (!requiresInitialClaim()) {
    return { ok: false, error: 'El acceso administrativo ya fue configurado previamente.' };
  }
  if (typeof password !== 'string' || password.trim().length < 8) {
    return { ok: false, error: 'La contraseña inicial debe tener al menos 8 caracteres.' };
  }

  const saltHex = crypto.randomBytes(16).toString('hex');
  const hashHex = hashPasswordScrypt(password.trim(), saltHex);
  const payload: StoredAdminAuth = {
    saltHex,
    hashHex,
    claimedAt: new Date().toISOString(),
  };

  const target = getAuthFilePath();
  const tmpTarget = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmpTarget, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpTarget, target);
  return { ok: true };
}

export function verifyAdminPassword(password: string): boolean {
  if (typeof password !== 'string' || !password.trim()) return false;
  const candidate = password.trim();

  const envPasscode = process.env.ADMIN_DASHBOARD_PASSCODE?.trim();
  if (envPasscode) {
    return constantTimeStringEqual(candidate, envPasscode);
  }

  const stored = readStoredAdminAuth();
  if (!stored) return false;

  const derived = hashPasswordScrypt(candidate, stored.saltHex);
  const bufA = Buffer.from(derived, 'hex');
  const bufB = Buffer.from(stored.hashHex, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function issueSessionToken(): { token: string; expiresAt: string } {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp, nonce })).toString('base64url');
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('base64url');
  return {
    token: `${payload}.${sig}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;

  const expectedSig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('base64url');
  const bufA = Buffer.from(sig);
  const bufB = Buffer.from(expectedSig);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role?: string;
      exp?: number;
    };
    return parsed.role === 'admin' && typeof parsed.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim();
}

export function getAuthStatus(req: Request): AuthStatusResponse {
  const token = extractBearerToken(req);
  return {
    requiresClaim: requiresInitialClaim(),
    envPasscodeConfigured: isEnvPasscodeConfigured(),
    authenticated: verifySessionToken(token),
  };
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!verifySessionToken(token)) {
    res.status(401).json({ error: 'Sesión administrativa requerida o expirada.' });
    return;
  }
  next();
}
