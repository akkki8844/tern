import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ConfigurationError, getLogger, randomToken } from "@tern/shared";
import { serverConfig } from "../../_runtime";
import { OAUTH_STATE_COOKIE, sessionCookieOptions } from "../../_session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("oauth-login");

/**
 * Begin GitHub OAuth for *user identity only*.
 *
 * Scope is deliberately `read:user`: this flow never asks for repository access.
 * Repository operations always go through the GitHub App installation.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const config = serverConfig();
  if (!config.githubOAuth.enabled) {
    logger.warn("sign-in attempted while OAuth is not configured");
    return NextResponse.json(
      new ConfigurationError("GitHub sign-in is not configured", { code: "OAUTH_NOT_CONFIGURED" }).toPublicJSON(),
      { status: 503 }
    );
  }

  const state = randomToken(24);
  const redirectUri = new URL("/api/auth/github/callback", config.githubOAuth.publicBaseUrl ?? new URL(request.url).origin);

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", config.githubOAuth.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri.toString());
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");

  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, state, sessionCookieOptions(config.isProduction, 10 * 60 * 1000));

  return NextResponse.redirect(authorize.toString(), { status: 302 });
}
