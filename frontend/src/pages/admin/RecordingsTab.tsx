import { useEffect, useState } from "react";
import Select from "../../components/Select";
import { updateRecordings } from "../../api";

export default function RecordingsTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [enabled, setEnabled] = useState(settings.recordings_enabled === "true");
  const [days, setDays] = useState(settings.recordings_retention_days || "30");
  const [storageType, setStorageType] = useState(settings.recordings_storage_type || "local");
  const [azureAccount, setAzureAccount] = useState(settings.recordings_azure_account_name || "");
  const [azureContainer, setAzureContainer] = useState(
    settings.recordings_azure_container_name || "recordings"
  );
  const [azureKey, setAzureKey] = useState(settings.recordings_azure_access_key || "");

  useEffect(() => {
    setEnabled(settings.recordings_enabled === "true");
    setDays(settings.recordings_retention_days || "30");
    setStorageType(settings.recordings_storage_type || "local");
    setAzureAccount(settings.recordings_azure_account_name || "");
    setAzureContainer(settings.recordings_azure_container_name || "recordings");
    setAzureKey(settings.recordings_azure_access_key || "");
  }, [settings]);

  return (
    <div className="card">
      <h2>Session Recordings</h2>
      <div className="form-group">
        <label className="flex items-center gap-2" aria-label="Enable session recording">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="checkbox"
          />
          Enable session recording
        </label>
      </div>
      <div className="form-group">
        <label htmlFor="rec-retention-days">Retention (days)</label>
        <input
          id="rec-retention-days"
          type="number"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label htmlFor="rec-storage-backend">Storage Backend</label>
        <Select
          id="rec-storage-backend"
          value={storageType}
          onChange={(v) => setStorageType(v)}
          options={[
            { value: "local", label: "Local (Docker Volume)" },
            { value: "azure_blob", label: "Azure Blob Storage" },
          ]}
        />
      </div>
      {storageType === "azure_blob" && (
        <>
          <div className="form-group">
            <label htmlFor="rec-azure-account">Account Name</label>
            <input
              id="rec-azure-account"
              value={azureAccount}
              onChange={(e) => setAzureAccount(e.target.value)}
              placeholder="mystorageaccount"
            />
          </div>
          <div className="form-group">
            <label htmlFor="rec-azure-container">Container Name</label>
            <input
              id="rec-azure-container"
              value={azureContainer}
              onChange={(e) => setAzureContainer(e.target.value)}
              placeholder="recordings"
            />
          </div>
          <div className="form-group">
            <label htmlFor="rec-azure-key">Access Key</label>
            <input
              id="rec-azure-key"
              type="password"
              value={azureKey}
              onChange={(e) => setAzureKey(e.target.value)}
              placeholder="Base64-encoded storage account key"
            />
          </div>
        </>
      )}
      <button
        className="btn-primary"
        onClick={async () => {
          await updateRecordings({
            enabled,
            retention_days: parseInt(days),
            storage_type: storageType,
            azure_account_name: storageType === "azure_blob" ? azureAccount : undefined,
            azure_container_name: storageType === "azure_blob" ? azureContainer : undefined,
            azure_access_key: storageType === "azure_blob" ? azureKey : undefined,
          });
          onSave();
        }}
      >
        Save Recording Settings
      </button>
    </div>
  );
}
