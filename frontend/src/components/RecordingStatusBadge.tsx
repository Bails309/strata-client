import type { HistoricalRecording } from "../api";

const LABELS: Record<string, string> = {
  recording: "In progress",
  incomplete: "Incomplete",
  failed: "Failed",
};

/** Flags a recording that is not a complete record of its session. */
export default function RecordingStatusBadge({
  recording,
}: {
  recording: Pick<HistoricalRecording, "status" | "failure">;
}) {
  const label = recording.status ? LABELS[recording.status] : undefined;
  if (!label) return null;
  const tone =
    recording.status === "recording" ? "bg-accent-dim text-accent" : "bg-danger/10 text-danger";
  return (
    <span
      className={`ml-2 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${tone}`}
      title={recording.failure ?? undefined}
    >
      {label}
    </span>
  );
}
