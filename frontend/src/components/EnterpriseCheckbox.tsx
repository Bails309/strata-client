import React, { useEffect, useId, useRef } from "react";

export interface EnterpriseCheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> {
  checked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: string;
}

export const EnterpriseCheckbox: React.FC<EnterpriseCheckboxProps> = ({
  checked = false,
  indeterminate = false,
  onCheckedChange,
  className = "",
  disabled = false,
  id,
  label,
  ...props
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const inputId = id || generatedId;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label
      htmlFor={inputId}
      className={`relative inline-flex items-center justify-center select-none cursor-pointer ${
        disabled ? "opacity-40 cursor-not-allowed" : ""
      } ${className}`}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onCheckedChange?.(e.target.checked);
          props.onChange?.(e);
        }}
        className="sr-only peer"
        {...props}
      />
      <div
        className="
          w-4 h-4 rounded-[4px] border flex items-center justify-center transition-colors duration-100 ease-in-out shrink-0
          /* Unchecked State */
          bg-[#0B131F]/70 border-slate-600/40
          /* Hover State */
          hover:border-[#3ACEEF] hover:bg-[#3ACEEF]/10
          /* Checked & Indeterminate States */
          peer-checked:bg-[#3ACEEF] peer-checked:border-[#3ACEEF]
          peer-indeterminate:bg-[#3ACEEF] peer-indeterminate:border-[#3ACEEF]
          /* Keyboard Focus-Visible */
          peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#070B12] peer-focus-visible:ring-[#3ACEEF]
        "
        style={{
          width: "var(--cb-size, 16px)",
          height: "var(--cb-size, 16px)",
          borderRadius: "var(--cb-radius, 4px)",
        }}
      >
        {checked && !indeterminate && (
          <svg
            className="w-3 h-3 text-white pointer-events-none"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--cb-icon-color, currentColor)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
          </svg>
        )}
        {indeterminate && (
          <svg
            className="w-3 h-3 text-white pointer-events-none"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--cb-icon-color, currentColor)"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <line x1="4" y1="8" x2="12" y2="8" />
          </svg>
        )}
      </div>
      {label && <span className="ml-2 text-sm text-txt-primary">{label}</span>}
    </label>
  );
};

export default EnterpriseCheckbox;
