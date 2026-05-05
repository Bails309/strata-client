import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";

/**
 * Form-field wrapper that programmatically associates a `<label>` with a
 * single child control via `htmlFor`/`id`.
 *
 * If the child already has an `id`, it is preserved and reused on the label;
 * otherwise a stable React `useId()` value is injected onto the child.
 *
 * Used in place of the legacy `<div className="form-group"><label/>…</div>`
 * pattern so that `jsx-a11y/label-has-associated-control` is satisfied
 * without per-site id bookkeeping.
 */
export function Field({
  label,
  title,
  className = "form-group !mb-0",
  children,
}: {
  label: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  let resolvedId = generatedId;
  let wired: ReactNode = children;

  if (isValidElement(children)) {
    const child = children as ReactElement<{ id?: string }>;
    const existing = child.props.id;
    resolvedId = existing ?? generatedId;
    wired = existing ? child : cloneElement(child, { id: resolvedId });
  }

  return (
    <div className={className}>
      <label htmlFor={resolvedId} title={title}>
        {label}
      </label>
      {wired}
    </div>
  );
}
