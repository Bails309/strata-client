-- Add configurable display settings for time and date
INSERT INTO system_settings (key, value) VALUES
    ('display_timezone',    'UTC'),
    ('display_time_format', 'HH:mm:ss'),
    ('display_date_format', 'YYYY-MM-DD')
ON CONFLICT (key) DO NOTHING;
