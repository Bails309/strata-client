interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDangerous?: boolean;
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  isDangerous = false,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-sm shadow-2xl animate-in fade-in zoom-in duration-200"
        onClick={(e) => e.stopPropagation()}
        style={{
          border: isDangerous ? '1px solid var(--color-danger-dim, rgba(239, 68, 68, 0.2))' : undefined,
        }}
      >
        <div className="flex items-center gap-3 mb-4">
          {isDangerous && (
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-danger/10 text-danger">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          )}
          <h3 className="text-lg font-bold !mb-0">{title}</h3>
        </div>

        <p className="text-sm text-txt-secondary mb-6 leading-relaxed">
          {message}
        </p>

        <div className="flex gap-3">
          <button className="btn flex-1" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={isDangerous ? 'btn-danger flex-1' : 'btn-primary flex-1'}
            onClick={() => {
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
