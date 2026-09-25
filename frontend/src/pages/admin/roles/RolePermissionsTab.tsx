import { useMemo, useState } from "react";
import EnterpriseCheckbox from "../../../components/EnterpriseCheckbox";
import {
  PERMISSION_CATEGORIES,
  impliedBySystem,
  type RiskTier,
  type RoleDraft,
  type RoleFlag,
} from "./roleModel";

const RISK_LABEL: Record<RiskTier, string> = {
  critical: "Critical",
  elevated: "Elevated",
  standard: "Standard",
};

export function PermissionRiskBadge({ risk }: { risk: RiskTier }) {
  return <span className={`role-risk role-risk-${risk}`}>{RISK_LABEL[risk]}</span>;
}

interface Props {
  draft: RoleDraft;
  onToggle: (flag: RoleFlag) => void;
}

export default function RolePermissionsTab({ draft, onToggle }: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const q = search.trim().toLowerCase();
  const categories = useMemo(
    () =>
      PERMISSION_CATEGORIES.map((c) => ({
        ...c,
        permissions: c.permissions.filter(
          (p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
        ),
      })).filter((c) => c.permissions.length > 0),
    [q]
  );

  const granted = PERMISSION_CATEGORIES.flatMap((c) => c.permissions).filter((p) => draft[p.flag]);
  const critical = granted.filter((p) => p.risk === "critical").length;
  const elevated = granted.filter((p) => p.risk === "elevated").length;

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
            placeholder="Filter permissions by keyword or capability…"
            aria-label="Filter permissions"
          />
        </label>
        <span className="role-summary" aria-live="polite">
          {granted.length} granted
          {critical > 0 && <span className="role-summary-critical"> · {critical} critical</span>}
          {elevated > 0 && <span className="role-summary-elevated"> · {elevated} elevated</span>}
        </span>
      </div>

      {categories.length === 0 && (
        <p className="role-empty">No permissions match &quot;{search}&quot;.</p>
      )}

      {categories.map((cat) => {
        const open = q !== "" || !collapsed.has(cat.id);
        const grantedHere = cat.permissions.filter((p) => draft[p.flag]).length;
        return (
          <section key={cat.id} className="role-section">
            <button
              type="button"
              className="role-section-header"
              aria-expanded={open}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(cat.id)) next.delete(cat.id);
                  else next.add(cat.id);
                  return next;
                })
              }
            >
              <svg
                className={`role-chevron${open ? " role-chevron-open" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="role-section-title">{cat.title}</span>
              <span className="role-section-count">
                {grantedHere} of {cat.permissions.length}
              </span>
            </button>

            {open && (
              <div className="role-section-rows">
                {cat.permissions.map((perm) => {
                  const descId = `role-perm-desc-${perm.flag}`;
                  const implied = impliedBySystem(perm.flag) && draft.can_manage_system;
                  return (
                    <label
                      key={perm.flag}
                      className={`role-perm-row${draft[perm.flag] ? " role-perm-row-on" : ""}`}
                    >
                      <EnterpriseCheckbox
                        as="span"
                        className="role-perm-check"
                        checked={draft[perm.flag]}
                        onCheckedChange={() => onToggle(perm.flag)}
                        aria-label={perm.name}
                        aria-describedby={descId}
                      />
                      <span className="role-perm-text">
                        <span className="role-perm-name">
                          {perm.name}
                          <PermissionRiskBadge risk={perm.risk} />
                        </span>
                        <span id={descId} className="role-perm-desc">
                          {perm.description}
                          {implied && !draft[perm.flag] && (
                            <span className="role-perm-implied">
                              {" "}
                              Already granted through Administer system.
                            </span>
                          )}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
