import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AuthenticationError, getLogger, internalMessageOf, isCapibaraError, publicMessageOf } from "@capibara/shared";
import { auditLogger, prisma, serverConfig } from "../../../_runtime";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, createSession, sessionCookieOptions, verifyOAuthState } from "../../../_session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("oauth-callback");
const TOKEN_TIMEOUT_MS = 10_000;

/**
 * Complete GitHub OAuth.
 *
 * The `code` is exchanged for a user access token, the token is used once to read the
 * profile, and it is then discarded — nothing about it is persisted or logged.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const config = serverConfig();
  if (!config.githubOAuth.enabled) {
    return NextResponse.json({ error: { code: "OAUTH_NOT_CONFIGURED", message: "Sign-in is not configured." } }, { status: 503 });
  }

  const url = new URL(request.url);
  const store = await cookies();

  try {
    if (url.searchParams.get("error")) {
      throw new AuthenticationError("GitHub denied the authorization request", { code: "OAUTH_DENIED" });
    }

    verifyOAuthState(store.get(OAUTH_STATE_COOKIE)?.value, url.searchParams.get("state"));
    store.delete(OAUTH_STATE_COOKIE);

    const code = url.searchParams.get("code");
    if (!code || code.length > 512) {
      throw new AuthenticationError("Missing authorization code", { code: "OAUTH_CODE_MISSING" });
    }

    const accessToken = await exchangeCode(code, config, url.origin);
    const profile = await fetchProfile(accessToken);

    const user = await prisma().user.upsert({
      where: { githubId: String(profile.id) },
      create: {
        githubId: String(profile.id),
        login: profile.login,
        name: profile.name ?? null,
        avatarUrl: profile.avatar_url ?? null
      },
      update: { login: profile.login, name: profile.name ?? null, avatarUrl: profile.avatar_url ?? null }
    });

    const session = await createSession(user.id, {
      userAgent: request.headers.get("user-agent"),
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    });

    store.set(SESSION_COOKIE, session.token, sessionCookieOptions(config.isProduction, session.expiresAt.getTime() - Date.now()));

    await auditLogger().record({
      actor: user.login,
      actorType: "user",
      action: "user.signed_in",
      resourceType: "User",
      resourceId: user.id,
      userId: user.id
    });

    logger.info("user signed in", { userId: user.id, login: user.login });
    return NextResponse.redirect(new URL("/dashboard", config.githubOAuth.publicBaseUrl ?? url.origin), { status: 302 });
  } catch (error) {
    logger.warn("sign-in failed", { reason: internalMessageOf(error) });
    const status = isCapibaraError(error) && error.category === "AUTHENTICATION" ? 401 : 500;
    return NextResponse.json({ error: { code: "OAUTH_FAILED", message: publicMessageOf(error) } }, { status });
  }
}

async function exchangeCode(code: string, config: ReturnType<typeof serverConfig>, origin: string): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubOAuth.clientId,
      client_secret: config.githubOAuth.clientSecret.reveal(),
      code,
      redirect_uri: new URL("/api/auth/github/callback", config.githubOAuth.publicBaseUrl ?? origin).toString()
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new AuthenticationError("Token exchange failed", { code: "OAUTH_EXCHANGE_FAILED", details: { status: response.status } });
  }

  const body = (await response.json()) as { access_token?: unknown; error?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    // Never include the response body: it can contain credential material.
    throw new AuthenticationError("Token exchange returned no access token", { code: "OAUTH_EXCHANGE_INVALID" });
  }
  return body.access_token;
}

async function fetchProfile(accessToken: string): Promise<{ id: number; login: string; name?: string | null; avatar_url?: string | null }> {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new AuthenticationError("Could not read the GitHub profile", { code: "OAUTH_PROFILE_FAILED" });
  }
  const profile = (await response.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown };
  if (typeof profile.id !== "number" || typeof profile.login !== "string") {
    throw new AuthenticationError("GitHub profile response was malformed", { code: "OAUTH_PROFILE_INVALID" });
  }
  return {
    id: profile.id,
    login: profile.login,
    name: typeof profile.name === "string" ? profile.name : null,
    avatar_url: typeof profile.avatar_url === "string" ? profile.avatar_url : null
  };
}
