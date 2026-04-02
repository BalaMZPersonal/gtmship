export function inferSharedOAuthProviderKeyFromSlug(
  slug: string | null | undefined
): string | null {
  switch (slug) {
    case "gmail":
    case "google-sheets":
      return "google";
    default:
      return null;
  }
}

export function resolveSharedOAuthProviderKey(input: {
  slug?: string | null;
  oauthProviderKey?: string | null;
}): string | null {
  return input.oauthProviderKey || inferSharedOAuthProviderKeyFromSlug(input.slug) || null;
}
