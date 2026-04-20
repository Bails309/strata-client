# What's New in v0.19.3

## 🚀 Separate User Discovery Search Bases

We have introduced a major refinement to the Active Directory synchronization engine by decoupling user discovery from device discovery.

### Why this matters

Previously, AD sync relied on a single set of Search Base OUs for discovering both machine accounts (for remote connections) and user accounts (for password management). In large organizations, IT admins often store servers and privileged user accounts in entirely different OU trees.

With **Separate PM Search Bases**, you can now:
- **Tighten your security perimeter**: Scope user discovery exclusively to high-value account OUs without exposing the entire machine directory.
- **Reduce discovery noise**: Only sync the accounts that actually need rotation and checkouts.
- **Maintain flexibility**: Use different bind credentials for the PM discovery if your organizational policy requires separate service accounts for user management.

### How to use it

1. Navigate to **Admin Settings** → **AD Sync**.
2. Edit an existing AD Sync Source or create a new one.
3. In the **Password Management** section, you will find the new **Search Base OUs (Optional)** field.
4. Add one or more OUs specifically for your user accounts.

> [!TIP]
> If you leave this field empty, Strata will automatically fall back to your main Search Bases, so your existing configurations will continue to work perfectly!

---

## 🛠️ Additional Technical Updates

- **Migration 049**: Safely introduces the schema changes required for scoped user discovery.
- **Refined Filter Preview**: The "Preview" button in the AD Sync modal now accurately reflects your scoped PM Search Bases, providing immediate feedback on account matches.
- **TypeScript & Rust Stability**: Full stack type safety updates across the API and frontend components to ensure a reliable management experience.

---
*For a full technical list of changes, please refer to the [CHANGELOG.md](file:///c:/GitRepos/strata-client/CHANGELOG.md).*
