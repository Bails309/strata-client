import { useState } from "react";
import Select from "../../components/Select";
import { updateSettings } from "../../api";
import { formatDateTime, getTimezones } from "../../utils/time";

export default function DisplayTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [timezone, setTimezone] = useState(settings.display_timezone || "UTC");
  const [dateFormat, setDateFormat] = useState(settings.display_date_format || "YYYY-MM-DD");
  const [timeFormat, setTimeFormat] = useState(settings.display_time_format || "HH:mm:ss");
  const [saving, setSaving] = useState(false);

  const timezones = getTimezones();

  async function handleSave() {
    setSaving(true);
    try {
      await updateSettings([
        { key: "display_timezone", value: timezone },
        { key: "display_date_format", value: dateFormat },
        { key: "display_time_format", value: timeFormat },
      ]);
      onSave();
    } catch {
      /* ignored */
    }
    setSaving(false);
  }

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Display Preferences</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Configure how dates, times, and timezones are displayed throughout the application.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div className="space-y-6">
          <div className="form-group">
            <label htmlFor="display-timezone" className="block text-sm font-medium mb-2">Display Timezone</label>
            <p className="text-xs text-txt-secondary mb-3">
              All timestamps in logs and sessions will be converted to this timezone.
            </p>
            <Select
              id="display-timezone"
              value={timezone}
              onChange={setTimezone}
              options={timezones.map((tz) => ({ value: tz, label: tz }))}
            />
          </div>

          <div className="form-group">
            <label htmlFor="display-date-format" className="block text-sm font-medium mb-2">Date Format</label>
            <Select
              id="display-date-format"
              value={dateFormat}
              onChange={setDateFormat}
              options={[
                { value: "YYYY-MM-DD", label: "ISO (YYYY-MM-DD)" },
                { value: "DD/MM/YYYY", label: "European (DD/MM/YYYY)" },
                { value: "MM/DD/YYYY", label: "US (MM/DD/YYYY)" },
                { value: "DD-MM-YYYY", label: "DD-MM-YYYY" },
              ]}
            />
          </div>

          <div className="form-group">
            <label htmlFor="display-time-format" className="block text-sm font-medium mb-2">Time Format</label>
            <Select
              id="display-time-format"
              value={timeFormat}
              onChange={setTimeFormat}
              options={[
                { value: "HH:mm:ss", label: "24 Hour (HH:mm:ss)" },
                { value: "hh:mm:ss A", label: "12 Hour (hh:mm:ss AM/PM)" },
                { value: "HH:mm", label: "24 Hour Simple (HH:mm)" },
              ]}
            />
          </div>
        </div>

        <div className="bg-surface-secondary/30 p-6 rounded-lg border border-border/50 self-start">
          <h4 className="text-sm font-semibold uppercase tracking-wider mb-4 opacity-70">
            Preview
          </h4>
          <div className="space-y-4">
            <div>
              <div className="text-[10px] uppercase font-bold opacity-40 mb-1">
                Standard Timestamp
              </div>
              <div className="text-xl font-mono tabular-nums">
                {formatDateTime(new Date(), {
                  display_timezone: timezone,
                  display_date_format: dateFormat,
                  display_time_format: timeFormat,
                })}
              </div>
            </div>
            <div className="text-xs text-txt-secondary flex items-center gap-2">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Timezone: {timezone}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-border/10">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Display Settings"}
        </button>
      </div>
    </div>
  );
}
