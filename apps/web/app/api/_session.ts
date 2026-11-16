import { cookies } from "next/headers";
import { AuthenticationError, randomToken, safeEqual, sha256Hex } from "@capibara/shared";
import { prisma } from "./_runtime";

export const SESSION_COOKIE = "capibara_session";
export const OAUTH_STATE_COOKIE = "capibara_oauth_state";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * User sessions.
 *
 * The cookie holds a random opaque token; only its SHA-256 is stored, so a database
 * dump cannot be replayed as a login. The GitHub *user* access token is used once, at
 * callback time, to read the profile and is then discarded — user identity and
 * repository access are two separate security contexts, and only the GitHub App may
 * touch repositories.
 */
export interface SessionUser {
  id: string;
  githubId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export function sessionCookieOptions(secure: boolean, maxAgeMs: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000)
  };
}

export async function createSession(
  userId: string,
  metadata: { userAgent?: string | null; ip?: string | null }
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma().session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      userAgent: metadata.userAgent?.slice(0, 500) ?? null,
      ipHash: metadata.ip ? sha256Hex(metadata.ip).slice(0, 32) : null,
      expiresAt
    }
  });
  return { token, expiresAt };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma().session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: true }
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;

  return {
    id: session.user.id,
    githubId: session.user.githubId,
    login: session.user.login,
    name: session.user.name,
    avatarUrl: session.user.avatarUrl
  };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma()
    .session.updateMany({ where: { tokenHash: sha256Hex(token) }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

/** Constant-time CSRF state check for the OAuth callback. */
export function verifyOAuthState(expected: string | undefined, received: string | null): void {
  if (!expected || !received || !safeEqual(expected, received)) {
    throw new AuthenticationError("OAuth state mismatch", {
      code: "OAUTH_STATE_MISMATCH",
      publicMessage: "Sign-in could not be completed. Please try again."
    });
  }
}
