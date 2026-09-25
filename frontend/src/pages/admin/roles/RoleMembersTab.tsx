import { useState } from "react";
import type { User } from "../../../api";
import { useSettings } from "../../../contexts/SettingsContext";

interface Props {
  members: User[];
}

export default function RoleMembersTab({ members }: Props) {
  const { formatDateTime } = useSettings();
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const shown = members.filter(
    (u) =>
      !q ||
      u.username.toLowerCase().includes(q) ||
      (u.full_name ?? "").toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q)
  );

  return (
    <div className="role-tab-body">
      <div className="role-toolbar">
        <label className="role-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter members…"
            aria-label="Filter members"
          />
        </label>
        <span className="role-summary">Change a user&apos;s role from the Users table.</span>
      </div>

      <div className="role-tree-card">
        <div className="role-tree-caption">
          Assigned users ({members.length})<span>Each user holds exactly one role.</span>
        </div>
        {members.length === 0 ? (
          <p className="role-empty">No users hold this role.</p>
        ) : shown.length === 0 ? (
          <p className="role-empty">No members match &quot;{search}&quot;.</p>
        ) : (
          <ul className="role-members" aria-label="Role members">
            {shown.map((u) => (
              <li key={u.id} className="role-member">
                <span className="role-member-avatar" aria-hidden>
                  {(u.full_name || u.username).slice(0, 1).toUpperCase()}
                </span>
                <span className="role-member-text">
                  <span className="role-tree-name">{u.full_name || u.username}</span>
                  <span className="role-tree-target">
                    {u.username}
                    {u.email ? ` · ${u.email}` : ""}
                  </span>
                </span>
                <span className="role-member-meta">
                  <span className={`role-auth role-auth-${u.auth_type}`}>
                    {u.auth_type === "sso" ? "SSO" : "Local"}
                  </span>
                  <span className="role-status-none">
                    {u.last_login_at
                      ? `Last login ${formatDateTime(u.last_login_at)}`
                      : "Never signed in"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
