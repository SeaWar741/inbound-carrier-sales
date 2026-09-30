"use client";

// Writes URL state. Empty values drop the key. replaceState keeps the back button for leaving the
// page, not for every click.
export function updateSearch(changes: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}
