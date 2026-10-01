// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

/* Kept apart from WhatsNewModal, whose release history is large, so the
   shell can decide whether to load it at all. */

export const WHATS_NEW_STORAGE_KEY = "strata-whats-new-dismissed";
export const WELCOME_STORAGE_KEY = "strata-welcome-dismissed";

/** Whether the welcome or what's-new modal has something to show this user. */
export function whatsNewPending(userId: string | undefined): boolean {
  if (!userId) return false;
  return (
    !localStorage.getItem(`${WELCOME_STORAGE_KEY}-${userId}`) ||
    localStorage.getItem(`${WHATS_NEW_STORAGE_KEY}-${userId}`) !== __APP_VERSION__
  );
}
