import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { getDisplaySettings, updateSettings as apiUpdateSettings } from "../api";
import { TimeSettings, formatDateTime as formatUtil } from "../utils/time";

interface SettingsContextType {
  settings: Record<string, string>;
  timeSettings: TimeSettings;
  loading: boolean;
  refreshSettings: () => Promise<void>;
  updateSettings: (kv: { key: string; value: string }[]) => Promise<void>;
  formatDateTime: (date: string | number | Date | null) => string;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refreshSettings = useCallback(async () => {
    // Skip fetching admin settings when not authenticated — avoids noisy
    // 401 errors in the browser console on the login page.
    if (!localStorage.getItem("access_token")) {
      setLoading(false);
      return;
    }
    try {
      const data = await getDisplaySettings();
      setSettings(data);
    } catch (error) {
      console.error("Failed to fetch settings:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateSettings = async (kv: { key: string; value: string }[]) => {
    await apiUpdateSettings(kv);
    await refreshSettings();
  };

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  const timeSettings: TimeSettings = {
    display_timezone: settings.display_timezone || "UTC",
    display_time_format: settings.display_time_format || "HH:mm:ss",
    display_date_format: settings.display_date_format || "YYYY-MM-DD",
  };

  const formatDateTime = useCallback(
    (date: string | number | Date | null) => {
      return formatUtil(date, timeSettings);
    },
    [timeSettings]
  );

  return (
    <SettingsContext.Provider
      value={{ settings, timeSettings, loading, refreshSettings, updateSettings, formatDateTime }}
    >
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
};
